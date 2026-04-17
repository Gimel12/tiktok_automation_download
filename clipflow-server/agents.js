// Agent Manager — Full automation workflow
// Flow: YouTube channel → fetch shorts → process → dub → schedule on Buffer

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { fetchLatest, fetchPage, resolveChannel } = require('./pipeline/channel-fetcher');
const { scheduleClipPosts, getChannels, createPost, BUFFER_TOKEN } = require('./buffer');

// ── Title & Hashtag Helpers ────────────────────────────────────────────
const HASHTAG_POOLS = {
  taxes:   ['#impuestos','#taxes','#taxseason','#temporadadetaxes','#declaraciondeimpuestos',
            '#taxeslatinos','#taxesmiami','#floridataxes','#taxesfl','#irs','#reembolso',
            '#itintaxes','#taxesenflorida','#latinstaxes'],
  finance: ['#finanzaspersonales','#dinerotips','#finanzaslatinas','#ahorro','#inversiones',
            '#libertadfinanciera','#dinero','#finances','#money','#creditoscore',
            '#prestamos','#bienestarfinanciero'],
  default: ['#viral','#parati','#foryou','#fyp','#trending','#tiktoklatino',
            '#hispanictiktok','#latinos','#miami','#florida','#contenidoespanol'],
};

function detectCategory(titles = []) {
  const text = titles.join(' ').toLowerCase();
  if (/tax|impuesto|declar|itin|irs|reembolso|rembols/.test(text)) return 'taxes';
  if (/inver|ahorro|dinero|financ|money|wealth|crypto|stock|credito/.test(text)) return 'finance';
  return 'default';
}

function generateHashtags(clip) {
  const cat = detectCategory(clip.titles);
  const pool = [...new Set([...HASHTAG_POOLS[cat], ...HASHTAG_POOLS.default])];
  return pool.slice(0, 15).join(' ');
}

// Score a title by viral hooks: emojis, numbers, power words, question marks
function scoreTitleViralness(title = '') {
  let score = 0;
  if (/\d/.test(title)) score += 2;               // has numbers
  if (/[¿?]/.test(title)) score += 2;             // question = curiosity
  if (/[!¡]/.test(title)) score += 1;             // excitement
  const emojiCount = (title.match(/\p{Emoji}/gu) || []).length;
  score += Math.min(emojiCount * 1.5, 4);          // emojis (capped)
  const powerWords = /gratis|secreto|nadie|error|urgente|alerta|descubre|millones|cómo|hack|truco|verdad|nunca|siempre|rápido|fácil|dinero|ahorra/i;
  if (powerWords.test(title)) score += 3;
  score -= Math.max(0, (title.length - 80) / 20); // penalize too long
  return score;
}

function pickBestTitle(clip) {
  const titles = clip.titles || [];
  if (!titles.length) return clip.shortTitle || 'Video clip';
  // Always use Title 1 (index 0) — the faithful Spanish translation of the original video title
  return titles[0];
}

const AGENTS_FILE = path.join(__dirname, 'agents.json');
const AGENT_LOGS_FILE = path.join(__dirname, 'agent_logs.json');

// ── Persistence ────────────────────────────────────────────────────────
let agents = new Map();
let agentLogs = {};

function loadAgents() {
  try {
    if (fs.existsSync(AGENTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
      agents = new Map(data.map(a => [a.id, a]));
    }
    if (fs.existsSync(AGENT_LOGS_FILE)) {
      agentLogs = JSON.parse(fs.readFileSync(AGENT_LOGS_FILE, 'utf8'));
    }
  } catch (e) { console.error('Failed to load agents:', e.message); }
}

function saveAgents() {
  try {
    fs.writeFileSync(AGENTS_FILE, JSON.stringify([...agents.values()], null, 2));
    fs.writeFileSync(AGENT_LOGS_FILE, JSON.stringify(agentLogs, null, 2));
  } catch (e) { console.error('Failed to save agents:', e.message); }
}

// ── Agent CRUD ─────────────────────────────────────────────────────────
function createAgent({ name, channelUrl, shortsCount, dubSettings, schedule, bufferProfileIds, bufferAccessToken }) {
  const agent = {
    id: uuidv4(),
    name: name || 'Agente sin nombre',
    channelUrl,
    channelName: '',
    shortsCount: shortsCount || 10,
    watchMode: true, // always watch for new content
    contentType: 'shorts', // 'shorts', 'videos', 'both'
    lastCheckedAt: null,
    dubSettings: dubSettings || {},
    schedule: {
      enabled: schedule?.enabled ?? true,
      cronHour: schedule?.cronHour || 6, // run at 6am daily
      times: schedule?.times || ['09:00', '14:00', '19:00'],
      timezone: 'America/New_York',
    },
    bufferProfileIds: bufferProfileIds || [],
    bufferAccessToken: bufferAccessToken || '',
    status: 'idle', // idle | running | error | paused
    lastRun: null,
    lastError: null,
    createdAt: Date.now(),
    processedUrls: [], // track what's been processed to avoid duplicates
    stats: { totalRuns: 0, totalClips: 0, totalPosted: 0 },
  };
  agents.set(agent.id, agent);
  saveAgents();
  return agent;
}

function getAgent(id) { return agents.get(id); }
function getAllAgents() { return [...agents.values()]; }

function updateAgent(id, updates) {
  const agent = agents.get(id);
  if (!agent) throw new Error('Agent not found');
  Object.assign(agent, updates);
  saveAgents();
  return agent;
}

function deleteAgent(id) {
  agents.delete(id);
  delete agentLogs[id];
  saveAgents();
}

function toggleAgent(id) {
  const agent = agents.get(id);
  if (!agent) throw new Error('Agent not found');
  agent.status = agent.status === 'paused' ? 'idle' : 'paused';
  saveAgents();
  return agent;
}

// ── Logging ────────────────────────────────────────────────────────────
function addLog(agentId, message, type = 'info') {
  if (!agentLogs[agentId]) agentLogs[agentId] = [];
  const entry = { ts: Date.now(), message, type };
  agentLogs[agentId].unshift(entry);
  if (agentLogs[agentId].length > 200) agentLogs[agentId] = agentLogs[agentId].slice(0, 200);
  saveAgents();
  return entry;
}

function getLogs(agentId, limit = 50) {
  return (agentLogs[agentId] || []).slice(0, limit);
}

// ── Run Agent ──────────────────────────────────────────────────────────
// processVideoFn is server.js's processVideo/job runner
async function runAgent(agentId, processVideoFn, broadcast) {
  const agent = agents.get(agentId);
  if (!agent) throw new Error('Agent not found');
  if (agent.status === 'running') throw new Error('Agent already running');

  agent.status = 'running';
  agent.lastRun = Date.now();
  agent.stats.totalRuns++;
  saveAgents();
  broadcast({ type: 'agent_update', agent: safeAgent(agent) });

  const log = (msg, type = 'info') => {
    console.log(`[Agent ${agentId.slice(0,8)}] ${msg}`);
    addLog(agentId, msg, type);
    broadcast({ type: 'agent_log', agentId, entry: { ts: Date.now(), message: msg, type } });
  };

  try {
    log(`▶ Iniciando agente "${agent.name}"`);

    // Step 1: Resolve channel and fetch ALL new content
    log(`📡 Verificando canal: ${agent.channelUrl}`);
    let allNew = [];
    try {
      // Fetch a large batch (50) to catch up on any missed content
      const fetchCount = Math.max(agent.shortsCount, 50);
      const types = agent.contentType === 'both'
        ? ['shorts', 'videos']
        : [agent.contentType || 'shorts'];

      for (const type of types) {
        log(`🔍 Buscando ${type} nuevos...`);
        const items = await fetchLatest(agent.channelUrl, type, fetchCount);
        // Resolve channel name on first run
        if (!agent.channelName && items.length) {
          try {
            const info = await resolveChannel(agent.channelUrl);
            agent.channelName = info.name || agent.channelUrl;
            saveAgents();
          } catch {}
        }
        // Filter out already processed
        const newItems = items.filter(v => !agent.processedUrls.includes(v.url));
        log(`📊 ${type}: ${items.length} total, ${newItems.length} nuevos`);
        allNew.push(...newItems);
      }
    } catch (e) {
      throw new Error(`No se pudo verificar el canal: ${e.message}`);
    }

    agent.lastCheckedAt = Date.now();
    saveAgents();

    if (!allNew.length) {
      log(`✅ Sin contenido nuevo desde la última revisión — canal al día`, 'info');
      agent.status = 'idle';
      saveAgents();
      broadcast({ type: 'agent_update', agent: safeAgent(agent) });
      return { processed: 0, posted: 0 };
    }

    // Limit to shortsCount per run to avoid overwhelming the pipeline
    const toProcess = allNew.slice(0, agent.shortsCount);
    log(`🆕 ${allNew.length} video(s) nuevo(s) encontrado(s) — procesando ${toProcess.length} ahora`);

    // Step 3: Process each new video through the pipeline
    const processedClips = [];
    for (let i = 0; i < toProcess.length; i++) {
      const short = toProcess[i];
      log(`⚙️ Procesando ${i+1}/${toProcess.length}: ${short.title?.slice(0,50) || short.url}`);
      try {
        const jobId = uuidv4();
        const result = await processVideoFn(short.url, jobId, (progress) => {
          broadcast({ type: 'agent_log', agentId, entry: { ts: Date.now(), message: `  ${progress.label || '...'} ${progress.stepProgress || 0}%`, type: 'progress' } });
        }, { ...agent.dubSettings, no_cut: true, channelName: agent.channelName || agent.name }); // no-cut for shorts

        processedClips.push(...result.clips.map(c => ({ ...c, shortUrl: short.url, shortTitle: short.title })));
        agent.processedUrls.push(short.url);
        agent.stats.totalClips += result.clips.length;
        saveAgents();
        log(`✅ ${result.clips.length} clip(s) generados para: ${short.title?.slice(0,40) || short.url}`);
      } catch (e) {
        log(`❌ Error procesando ${short.url}: ${e.message}`, 'error');
      }
    }

    if (!processedClips.length) {
      throw new Error('No se generaron clips — revisa los errores arriba');
    }

    // Step 4: Schedule on Buffer if configured
    let posted = 0;
    if (agent.bufferAccessToken && agent.bufferProfileIds.length && processedClips.length) {
      log(`📅 Programando ${processedClips.length} clip(s) en Buffer...`);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      for (let i = 0; i < processedClips.length; i++) {
        const clip = processedClips[i];
        const postDate = new Date(tomorrow);
        postDate.setDate(postDate.getDate() + Math.floor(i / 3));

        // Build caption with 150 char TikTok limit
        const rawTitle = pickBestTitle(clip);
        const rawHashtags = generateHashtags(clip);
        const TIKTOK_LIMIT = 150;
        let caption = rawTitle;
        const tags = rawHashtags.split(/\s+/);
        let withTags = caption + '\n\n';
        for (const tag of tags) {
          if ((withTags + tag).length <= TIKTOK_LIMIT) withTags += tag + ' ';
          else break;
        }
        caption = withTags.trim();
        if (caption.length > TIKTOK_LIMIT) caption = caption.slice(0, TIKTOK_LIMIT).replace(/\s+\S*$/, '').trim();

        const videoUrl = clip.dubbedUrl || clip.url;
        const publicBase = process.env.PUBLIC_URL || `http://100.108.220.93:4000`;
        const publicVideoUrl = videoUrl.startsWith('http') ? videoUrl : `${publicBase}${videoUrl}`;

        try {
          // Resolve channels if needed
          const token = agent.bufferAccessToken || BUFFER_TOKEN;
          let channelIds = agent.bufferProfileIds || [];
          if (!channelIds.length) {
            const { channels } = await getChannels(token);
            channelIds = channels.filter(c => c.service === 'tiktok').map(c => c.id);
          }

          // Always save as draft — user reviews and schedules manually
          let ok = false;
          for (const chId of channelIds) {
            await createPost(token, null, chId, caption, publicVideoUrl, null, true);
            ok = true;
          }
          if (ok) posted++;
          log(`📱 Programado → "${rawTitle.slice(0,50)}…"`);
        } catch (e) {
          log(`⚠️ Error programando en Buffer: ${e.message}`, 'warn');
        }
      }
      agent.stats.totalPosted += posted;
      log(`✅ ${posted} post(s) programados en Buffer`);
    } else if (!agent.bufferAccessToken) {
      log('ℹ️ Buffer no configurado — clips procesados pero no programados', 'warn');
    }

    agent.status = 'idle';
    agent.lastError = null;
    saveAgents();
    broadcast({ type: 'agent_update', agent: safeAgent(agent) });
    log(`🎉 Agente completado — ${processedClips.length} clips, ${posted} programados en Buffer`, 'success');
    return { processed: processedClips.length, posted };

  } catch (e) {
    agent.status = 'error';
    agent.lastError = e.message;
    saveAgents();
    broadcast({ type: 'agent_update', agent: safeAgent(agent) });
    log(`❌ Error en agente: ${e.message}`, 'error');
    throw e;
  }
}

function safeAgent(a) {
  const { bufferAccessToken, ...rest } = a;
  return { ...rest, hasBufferToken: !!bufferAccessToken };
}

loadAgents();
module.exports = { createAgent, getAgent, getAllAgents, updateAgent, deleteAgent, toggleAgent, runAgent, getLogs, safeAgent };
