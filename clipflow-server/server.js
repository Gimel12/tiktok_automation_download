'use strict';

require('dotenv').config();

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const archiver   = require('archiver');
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');
const { processVideo } = require('./pipeline/processor');
const paymentsRouter = require('./payments');
const db             = require('./db');
const { resolveChannel, fetchLatest, getChannelName } = require('./pipeline/channel-fetcher');

const app = express();
const PORT = process.env.PORT || 4000;
const OUTPUT_DIR = path.join(__dirname, 'output');
const JOBS_FILE = path.join(__dirname, 'jobs.json');

// ── Persistent job store ───────────────────────────────────────────────
const jobs = new Map();

function saveJobs() {
  try {
    const data = [...jobs.values()].map(j => ({ ...j }));
    fs.writeFileSync(JOBS_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('Failed to save jobs:', e.message); }
}

function loadJobs() {
  if (!fs.existsSync(JOBS_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    for (const job of data) {
      // Mark any interrupted running jobs as error
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'error';
        job.error = 'Server was restarted while processing';
      }
      jobs.set(job.id, job);
    }
    console.log(`📂 Loaded ${jobs.size} saved job(s) from disk`);
  } catch (e) { console.error('Failed to load jobs:', e.message); }
}

// Load saved jobs on startup
loadJobs();

// ── SSE client registry ────────────────────────────────────────────────
const sseClients = new Set();

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (_) { sseClients.delete(client); }
  }
}

// ── Middleware ─────────────────────────────────────────────────────────
app.use(cookieParser());
// Webhook needs raw body — must come before express.json()
app.use('/pay/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
// Serve static files but NOT for /api/* routes
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path.startsWith('/pay/') || req.path.startsWith('/output/')) return next();
  express.static(path.join(__dirname, 'public'))(req, res, next);
});
app.use(paymentsRouter);

// ── Serve output files (clips) over HTTP ──────────────────────────────
app.use('/output', express.static(OUTPUT_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
    }
  }
}));

// ── POST /api/process ──────────────────────────────────────────────────
app.post('/api/process', (req, res) => {
  const { urls, dubSettings = {} } = req.body;
  // Default to no-cut mode (process full video as one clip)
  if (dubSettings.no_cut === undefined) dubSettings.no_cut = true;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls must be a non-empty array' });
  }

  // Auth + credit checks disabled for testing
  const sessionToken = req.cookies?.session;
  const email = db.verifySession(sessionToken) || 'test@clipflow.app';

  const jobIds = urls.map(url => {
    const id = uuidv4();
    const job = {
      id,
      url: String(url).trim(),
      status: 'queued',
      createdAt: Date.now(),
      progress: {},
      clips: [],
      dubSettings,
    };
    job.userEmail = email;
    jobs.set(id, job);
    saveJobs();
    broadcast({ type: 'job_created', job: safeJob(job) });
    runJob(job);
    return id;
  });

  res.json({ jobIds });
});

// ── GET /api/jobs ──────────────────────────────────────────────────────
app.get('/api/jobs', (_req, res) => {
  res.json([...jobs.values()].map(safeJob));
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(safeJob(job));
});

// ── DELETE /api/jobs/:id ───────────────────────────────────────────────
app.delete('/api/jobs/:id', (req, res) => {
  if (!jobs.has(req.params.id)) return res.status(404).json({ error: 'Job not found' });
  jobs.delete(req.params.id);
  saveJobs();
  res.json({ ok: true });
});

// ── GET /api/download/:id  — zip all clips ─────────────────────────────
app.get('/api/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(400).json({ error: 'Job not finished yet' });

  // Find the output dir for this job's video ID
  const clip = job.clips[0];
  if (!clip) return res.status(404).json({ error: 'No clips found' });

  const videoDir = path.dirname(clip.clipPath);
  if (!fs.existsSync(videoDir)) return res.status(404).json({ error: 'Output directory not found' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="tiktok_clips_${job.id.slice(0,8)}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { console.error('Archive error', err); res.end(); });
  archive.pipe(res);

  // Add only mp4 files
  const mp4s = fs.readdirSync(videoDir).filter(f => f.endsWith('.mp4') && f.startsWith('clip_'));
  mp4s.forEach(f => archive.file(path.join(videoDir, f), { name: f }));
  archive.finalize();
});

// ── GET /api/progress  (SSE) ───────────────────────────────────────────
app.get('/api/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const snapshot = [...jobs.values()].map(safeJob);
  res.write(`data: ${JSON.stringify({ type: 'snapshot', jobs: snapshot })}\n\n`);

  sseClients.add(res);
  const keepalive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(keepalive); }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
});

// ── Creators / Favorites ───────────────────────────────────────────────
const CREATORS_FILE = path.join(__dirname, 'creators.json');

function loadCreators() {
  if (!fs.existsSync(CREATORS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CREATORS_FILE, 'utf8')); } catch { return []; }
}
function saveCreators(list) {
  fs.writeFileSync(CREATORS_FILE, JSON.stringify(list, null, 2));
}

app.get('/api/creators', (_req, res) => {
  res.json(loadCreators());
});

app.post('/api/creators', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  let channelUrl, resolvedName;
  try {
    const result = resolveChannel(url);
    channelUrl   = result.channelUrl;
    resolvedName = result.name;
  } catch (e) {
    return res.status(400).json({ error: 'Could not resolve channel: ' + e.message });
  }

  const list = loadCreators();
  if (list.find(c => c.url === channelUrl))
    return res.status(409).json({ error: 'Creator already saved' });

  // Try to get the channel name if not resolved yet
  const name = resolvedName || getChannelName(channelUrl) || channelUrl.split('/').pop();

  const creator = { id: Date.now().toString(), url: channelUrl, name, addedAt: Date.now() };
  list.push(creator);
  saveCreators(list);
  res.json(creator);
});

app.delete('/api/creators/:id', (req, res) => {
  const list = loadCreators().filter(c => c.id !== req.params.id);
  saveCreators(list);
  res.json({ ok: true });
});

// Quick fetch — last 5 videos + 5 shorts
app.get('/api/creators/:id/videos', (req, res) => {
  const creator = loadCreators().find(c => c.id === req.params.id);
  if (!creator) return res.status(404).json({ error: 'Not found' });
  try {
    const videos = fetchLatest(creator.url, 'videos', 5);
    const shorts = fetchLatest(creator.url, 'shorts', 5);
    res.json({ videos, shorts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Browse all — paginated, with search + sort
app.get('/api/creators/:id/browse', (req, res) => {
  const creator = loadCreators().find(c => c.id === req.params.id);
  if (!creator) return res.status(404).json({ error: 'Not found' });

  const type   = req.query.type   || 'videos'; // videos | shorts
  const page   = parseInt(req.query.page || '1');
  const limit  = parseInt(req.query.limit || '20');
  const search = (req.query.search || '').toLowerCase().trim();
  const sort   = req.query.sort   || 'newest'; // newest | oldest

  const start = (page - 1) * limit + 1;
  const end   = page * limit;

  try {
    const { fetchPage } = require('./pipeline/channel-fetcher');
    const items = fetchPage(creator.url, type, start, end, sort);
    const filtered = search
      ? items.filter(v => v.title.toLowerCase().includes(search))
      : items;
    res.json({ items: filtered, page, limit, type, hasMore: items.length === limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolve channel name from URL (called when adding)
app.post('/api/creators/resolve', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const channelUrl = resolveChannel(url);
  const name = getChannelName(channelUrl);
  res.json({ url: channelUrl, name: name || url });
});

// NOTE: Agent + Buffer routes are defined below the Start block — SPA fallback must be last
// ── SPA fallback (must stay after all API routes) ─────────────────────
// Moved to end of file

// ── Job runner ─────────────────────────────────────────────────────────
async function runJob(job) {
  job.status = 'running';
  job.startedAt = Date.now();
  broadcast({ type: 'job_started', jobId: job.id });

  try {
    const result = await processVideo(job.url, job.id, (progress) => {
      job.progress = progress;
      broadcast({ type: 'job_progress', jobId: job.id, progress });
    }, job.dubSettings || {});

    // Attach HTTP-accessible URLs to each clip
    job.clips = result.clips.map(clip => {
      const rel = path.relative(OUTPUT_DIR, clip.clipPath).replace(/\\/g, '/');
      return {
        ...clip,
        url: `/output/${rel}`,
        filename: path.basename(clip.clipPath),
        dubbedUrl: clip.dubbedPath ? `/output/${path.relative(OUTPUT_DIR, clip.dubbedPath).replace(/\\/g, '/')}` : null,
        dubbedFilename: clip.dubbedPath ? path.basename(clip.dubbedPath) : null,
      };
    });

    job.status = 'done';
    job.finishedAt = Date.now();
    saveJobs();
    broadcast({ type: 'job_done', job: safeJob(job) });
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    job.finishedAt = Date.now();
    saveJobs();
    broadcast({ type: 'job_error', jobId: job.id, error: err.message });
    console.error(`Job ${job.id} failed:`, err);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────
function safeJob(job) {
  const { id, url, status, createdAt, startedAt, finishedAt, progress, clips, error } = job;
  return { id, url, status, createdAt, startedAt, finishedAt, progress, clips, error };
}

// ── AGENTS ────────────────────────────────────────────────────────────
const agentManager = require('./agents');

app.get('/api/agents', (_req, res) => {
  res.json(agentManager.getAllAgents().map(agentManager.safeAgent));
});

app.post('/api/agents', express.json(), (req, res) => {
  try {
    const agent = agentManager.createAgent(req.body);
    // Schedule cron if enabled
    scheduleAgentCron(agent);
    broadcast({ type: 'agent_update', agent: agentManager.safeAgent(agent) });
    res.json(agentManager.safeAgent(agent));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/agents/:id', express.json(), (req, res) => {
  try {
    const agent = agentManager.updateAgent(req.params.id, req.body);
    rescheduleAgentCron(agent);
    broadcast({ type: 'agent_update', agent: agentManager.safeAgent(agent) });
    res.json(agentManager.safeAgent(agent));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/agents/:id', (req, res) => {
  agentManager.deleteAgent(req.params.id);
  stopAgentCron(req.params.id);
  broadcast({ type: 'agent_deleted', agentId: req.params.id });
  res.json({ ok: true });
});

app.post('/api/agents/:id/toggle', (_req, res) => {
  try {
    const agent = agentManager.toggleAgent(_req.params.id);
    broadcast({ type: 'agent_update', agent: agentManager.safeAgent(agent) });
    res.json(agentManager.safeAgent(agent));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/agents/:id/run', async (req, res) => {
  try {
    const agent = agentManager.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json({ ok: true, message: 'Agent started' });
    // Run async after response
    agentManager.runAgent(agent.id, processVideo, broadcast).catch(console.error);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/agents/:id/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(agentManager.getLogs(req.params.id, limit));
});

app.get('/api/buffer/channels', async (req, res) => {
  const token = req.query.token || require('./buffer').BUFFER_TOKEN;
  try {
    const { getChannels } = require('./buffer');
    const result = await getChannels(token);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── AI Hashtag Generation ──────────────────────────────────────────────
app.post('/api/generate-hashtags', express.json(), async (req, res) => {
  const { videoTitle, transcriptSnippet, titles } = req.body;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = `Eres un experto en TikTok latino. Genera exactamente 15 hashtags en español e inglés para este video de TikTok.

Título del video original: ${videoTitle || 'N/A'}
Títulos virales generados: ${(titles || []).join(' | ')}
Fragmento del transcript: ${transcriptSnippet?.slice(0, 500) || 'N/A'}

Reglas:
- 15 hashtags en total
- Mezcla español e inglés
- Incluye hashtags específicos al TEMA del video (impuestos, bienes raíces, finanzas, etc.)
- Incluye 3-4 hashtags de alcance general TikTok (#fyp #parati #viral #trending)
- Incluye 2-3 hashtags latinos/hispanos
- NO incluyas hashtags irrelevantes
- Solo devuelve los hashtags separados por espacio, sin explicación, sin numeración

Ejemplo de formato: #impuestos #taxes #taxseason #realestate #dinero #fyp #parati #viral #trending #latinos #miami #florida #finanzas #ahorro #tiktoklatino`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    });
    const hashtags = message.content[0].text.trim();
    res.json({ hashtags });
  } catch (e) {
    // Fallback to basic hashtags if Claude fails
    res.json({ hashtags: '#viral #parati #foryou #fyp #trending #tiktoklatino #hispanictiktok #latinos #miami #florida #finanzas #dinero #impuestos #taxes #taxseason' });
  }
});

// ── Publish Clip to Buffer ─────────────────────────────────────────────
app.post('/api/publish-clip', express.json(), async (req, res) => {
  const { jobId, clipIndex, title, hashtags, scheduledAt, token, orgId, channelIds } = req.body;
  if (!jobId || clipIndex === undefined || !title || !scheduledAt) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos' });
  }
  try {
    const { createPost, getChannels, BUFFER_TOKEN } = require('./buffer');
    const useToken = token || BUFFER_TOKEN;

    // Resolve channels if not provided — auto-pick TikTok channel
    let useChannelIds = channelIds;
    if (!useChannelIds || !useChannelIds.length) {
      const { channels } = await getChannels(useToken);
      const tiktok = channels.filter(c => c.service === 'tiktok');
      useChannelIds = (tiktok.length ? tiktok : channels.slice(0, 1)).map(c => c.id);
    }
    if (!useChannelIds.length) throw new Error('No hay canales de TikTok conectados en Buffer');

    // Find clip video URL from job
    const job = jobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'Job no encontrado' });
    const clip = job.clips?.[clipIndex];
    if (!clip) return res.status(404).json({ error: 'Clip no encontrado' });

    const videoUrl = clip.dubbedUrl || clip.url;
    const publicBase = PUBLIC_URL || process.env.PUBLIC_URL || `http://100.108.220.93:${PORT}`;
    const publicVideoUrl = videoUrl.startsWith('http') ? videoUrl : `${publicBase}${videoUrl}`;

    // TikTok hard limit: 150 characters
    const TIKTOK_LIMIT = 150;
    let caption = title.trim();
    if (hashtags) {
      const tags = hashtags.trim().split(/\s+/);
      let withTags = caption + '\n\n';
      for (const tag of tags) {
        if ((withTags + tag).length <= TIKTOK_LIMIT) withTags += tag + ' ';
        else break;
      }
      caption = withTags.trim();
    }
    // Hard truncate at word boundary as safety net
    if (caption.length > TIKTOK_LIMIT) {
      caption = caption.slice(0, TIKTOK_LIMIT).replace(/\s+\S*$/, '').trim();
    }

    // Post to each channel — try scheduled with video, fall back to draft (TikTok API limitation)
    const results = [];
    let savedAsDraft = false;
    console.log(`[Buffer] Posting to ${useChannelIds.length} channel(s), video: ${publicVideoUrl}`);
    for (const chId of useChannelIds) {
      let r;
      try {
        // Try scheduled post with video
        r = await createPost(useToken, null, chId, caption, publicVideoUrl, scheduledAt, false);
        console.log(`[Buffer] Post result:`, JSON.stringify(r));
      } catch (e) {
        console.log(`[Buffer] Scheduled failed (${e.message}), trying draft with video...`);
        // Fall back to draft but KEEP the video URL
        r = await createPost(useToken, null, chId, caption, publicVideoUrl, null, true);
        savedAsDraft = true;
        console.log(`[Buffer] Draft result:`, JSON.stringify(r));
      }
      results.push(r);
    }
    const result = results[0];
    res.json({ ok: true, result, caption, scheduledAt, savedAsDraft });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Agent Cron Scheduler ───────────────────────────────────────────────
let nodeCron;
try { nodeCron = require('node-cron'); } catch { console.warn('node-cron not installed — agent scheduling disabled'); }
const agentCrons = new Map();

function scheduleAgentCron(agent) {
  if (!nodeCron || !agent.schedule?.enabled) return;
  const hour = agent.schedule.cronHour ?? 6;
  const cronExpr = `0 ${hour} * * *`; // daily at specified hour
  try {
    const task = nodeCron.schedule(cronExpr, () => {
      console.log(`[Cron] Running agent: ${agent.name}`);
      agentManager.runAgent(agent.id, processVideo, broadcast).catch(console.error);
    }, { timezone: agent.schedule.timezone || 'America/New_York' });
    agentCrons.set(agent.id, task);
    console.log(`[Cron] Scheduled agent "${agent.name}" at ${cronExpr}`);
  } catch (e) { console.error('[Cron] Failed to schedule agent:', e.message); }
}

function rescheduleAgentCron(agent) {
  stopAgentCron(agent.id);
  scheduleAgentCron(agent);
}

function stopAgentCron(agentId) {
  const task = agentCrons.get(agentId);
  if (task) { task.stop(); agentCrons.delete(agentId); }
}

// Schedule all existing agents on startup
agentManager.getAllAgents().forEach(agent => {
  if (agent.status !== 'paused') scheduleAgentCron(agent);
  // Reset any agents stuck in 'running' state from a previous crash
  if (agent.status === 'running') {
    agent.status = 'idle';
    agentManager.updateAgent(agent.id, { status: 'idle' });
    console.log(`[Startup] Reset stuck agent "${agent.name}" from running → idle`);
  }
});

// ── Resume pending HeyGen jobs after restart ────────────────────────────
async function resumePendingHeyGenJobs() {
  const { resumeDubJob } = require('./pipeline/dubber');
  const { getPending } = require('./pipeline/heygen-state');
  const pending = getPending();
  if (!pending.length) return;
  console.log(`[Startup] Resuming ${pending.length} interrupted HeyGen job(s)...`);
  for (const job of pending) {
    try {
      const dubbedPath = await resumeDubJob(job.translateId, job.dubbedPath, job.captionPath, job.settings || {});
      if (dubbedPath) {
        // Update the matching server job with the dubbed URL
        for (const [id, serverJob] of jobs.entries()) {
          if (!serverJob.clips) continue;
          for (const clip of serverJob.clips) {
            if (clip.clipPath === job.dubbedPath.replace(/_es\.mp4$/, '.mp4') ||
                clip.dubbedPath === job.dubbedPath ||
                (job.dubbedPath && job.dubbedPath.includes(serverJob.url?.split('?')[0]?.split('/').pop() || '____'))) {
              clip.dubbedUrl = dubbedPath.replace(path.join(__dirname, 'public'), '') || `/output/${path.basename(path.dirname(dubbedPath))}/${path.basename(dubbedPath)}`;
              clip.dubbedPath = dubbedPath;
              saveJobs();
              broadcast({ type: 'job_done', job: safeJob(serverJob) });
              console.log(`[Startup] Updated job ${id} with resumed dubbed clip`);
            }
          }
        }
      }
    } catch (e) {
      console.error(`[Startup] Failed to resume HeyGen job ${job.translateId}: ${e.message}`);
    }
  }
}

// ── Start Cloudflare tunnel for public video URLs ───────────────────────
const { execSync: execSyncCF, spawn } = require('child_process');
let PUBLIC_URL = process.env.PUBLIC_URL || '';
async function startCloudflareTunnel() {
  if (PUBLIC_URL) { console.log(`[CF] Using existing PUBLIC_URL: ${PUBLIC_URL}`); return; }
  try {
    const cf = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const waitForUrl = new Promise((resolve) => {
      const onData = (data) => {
        const match = data.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) { resolve(match[0]); cf.stdout.off('data', onData); cf.stderr.off('data', onData); }
      };
      cf.stdout.on('data', onData);
      cf.stderr.on('data', onData);
      setTimeout(() => resolve(null), 20000); // 20s timeout
    });
    const url = await waitForUrl;
    if (url) {
      PUBLIC_URL = url;
      process.env.PUBLIC_URL = url;
      require('fs').writeFileSync('/tmp/clipflow_public_url.txt', url);
      console.log(`[CF] Tunnel started: ${url}`);
    }
  } catch (e) { console.warn('[CF] Could not start tunnel:', e.message); }
}

// ── SPA fallback ─────────────────────────────────────────────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`TikTok Clip Machine running → http://192.168.12.207:${PORT}`);
  // Start tunnel first so PUBLIC_URL is set before any jobs run
  await startCloudflareTunnel();
  // Then resume any interrupted HeyGen jobs
  await resumePendingHeyGenJobs();
});
