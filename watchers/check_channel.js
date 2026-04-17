'use strict';

/**
 * ClipFlow Channel Watcher
 * Checks a YouTube channel's shorts for new uploads,
 * runs ClipFlow on any new video, and sends the Spanish-dubbed result to Telegram.
 */

require('dotenv').config({ path: __dirname + '/.env' });

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const https = require('https');

const CHANNEL_URL      = process.env.CHANNEL_URL  || 'https://www.youtube.com/@yourchannel/shorts';
const CLIPFLOW_API     = process.env.CLIPFLOW_API  || 'http://localhost:4000';
const STATE_FILE       = path.join(__dirname, 'state.json');
const TG_TOKEN         = process.env.TG_TOKEN;
const TG_CHAT_ID       = process.env.TG_CHAT_ID;
const COOKIES_FILE     = process.env.COOKIES_FILE  || '';
const POSTIZ_API_KEY   = process.env.POSTIZ_API_KEY;
const POSTIZ_TIKTOK_ID = process.env.POSTIZ_TIKTOK_ID;

// ── Public base URL (Cloudflare tunnel) ──────────────────────────────────────
// ClipFlow writes its tunnel URL to /tmp/clipflow_public_url.txt on every start.
// We use a stable custom domain instead of rotating tunnel URLs.
function getPublicBase() {
  return process.env.PUBLIC_DOMAIN || 'https://clips.yourdomain.com';
}

// ── State ─────────────────────────────────────────────────────────────────────
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { seen: [] };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { seen: [] }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ── Telegram ──────────────────────────────────────────────────────────────────
function tgSendText(text) {
  const payload = JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' });
  return tgRequest('sendMessage', payload);
}

function tgSendVideo(filePath, caption) {
  return new Promise((resolve, reject) => {
    const boundary = 'CFW' + Date.now();
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const pre = [
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${TG_CHAT_ID}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nMarkdown\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${fileName}"\r\nContent-Type: video/mp4\r\n\r\n`,
    ].join('');
    const body = Buffer.concat([
      Buffer.from(pre),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendVideo`,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function tgRequest(method, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// ── Fetch latest shorts ───────────────────────────────────────────────────────
function fetchLatestShorts(limit = 5) {
  console.log(`🔍 Checking: ${CHANNEL_URL}`);
  const cookiesArg = COOKIES_FILE && fs.existsSync(COOKIES_FILE) ? `--cookies "${COOKIES_FILE}"` : '';
  const cmd = `yt-dlp ${cookiesArg} --flat-playlist --playlist-end ${limit} -J "${CHANNEL_URL}" 2>/dev/null`;
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: 60000 });
    const data = JSON.parse(out);
    return (data.entries || []).map(e => ({
      id:        e.id,
      title:     e.title || 'Untitled',
      url:       `https://www.youtube.com/shorts/${e.id}`,
      timestamp: e.timestamp || e.upload_date || null,
    }));
  } catch (err) {
    console.error('❌ Failed to fetch channel:', err.message);
    return [];
  }
}

// ── Submit to ClipFlow + poll ─────────────────────────────────────────────────
async function runClipFlow(videoUrl) {
  const res = await fetch(`${CLIPFLOW_API}/api/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      urls: [videoUrl],
      dubSettings: { output_language: 'Spanish', enable_voice_clone: true, caption: true },
    }),
  });
  const { jobIds } = await res.json();
  const jobId = jobIds?.[0];
  if (!jobId) throw new Error('No job ID');
  console.log(`📋 Job: ${jobId}`);

  const start = Date.now();
  while (Date.now() - start < 1200000) { // 20 min max
    await sleep(15000);
    const r   = await fetch(`${CLIPFLOW_API}/api/jobs/${jobId}`);
    const job = await r.json();
    console.log(`   ⏳ [${job.status}] ${job.progress?.label || ''}`);
    if (job.status === 'done')  return job;
    if (job.status === 'error') throw new Error(job.error || 'ClipFlow error');
  }
  throw new Error('Timeout');
}

// ── Format date ───────────────────────────────────────────────────────────────
function formatDate(ts) {
  if (!ts) return 'Unknown date';
  if (typeof ts === 'string' && ts.length === 8)
    return `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}`;
  if (typeof ts === 'number')
    return new Date(ts * 1000).toISOString().slice(0, 10);
  return String(ts);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Upload video to public host so Buffer/Postiz can reach it ─────────────────
function uploadToTmpFiles(filePath) {
  return new Promise((resolve, reject) => {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const boundary = 'TMP' + Date.now();
    const pre = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: video/mp4\r\n\r\n`;
    const body = Buffer.concat([Buffer.from(pre), fileBuffer, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const req = https.request({
      hostname: 'tmpfiles.org', path: '/api/v1/upload', method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (json.status !== 'success') throw new Error('tmpfiles upload failed: ' + d);
          // Convert http://tmpfiles.org/XXXXX/file.mp4 → https://tmpfiles.org/dl/XXXXX/file.mp4
          const url = json.data.url.replace('http://', 'https://').replace('tmpfiles.org/', 'tmpfiles.org/dl/');
          console.log(`   ☁️  Uploaded to tmpfiles: ${url}`);
          resolve(url);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── Postiz (TikTok upload) ────────────────────────────────────────────────────
async function uploadToPostiz(videoFile, caption) {
  // Upload video file
  const fileBuffer = fs.readFileSync(videoFile);
  const boundary = 'postiz_xyz';
  const filename = path.basename(videoFile);
  const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`);
  const postBytes = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([pre, fileBuffer, postBytes]);

  const uploadRes = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.postiz.com', port: 443, path: '/public/v1/upload', method: 'POST',
      headers: { 'Authorization': POSTIZ_API_KEY, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Postiz upload: bad response')); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });

  if (!uploadRes.id) throw new Error(`Postiz upload failed: ${JSON.stringify(uploadRes)}`);
  console.log(`   ☁️  Uploaded to Postiz: ${uploadRes.path}`);

  const scheduleDate = new Date(Date.now() + 5 * 60 * 1000);
  const postPayload = JSON.stringify({
    type: 'schedule', date: scheduleDate.toISOString(), shortLink: false, tags: [],
    posts: [{
      integration: { id: POSTIZ_TIKTOK_ID },
      value: [{ content: caption, image: [{ id: uploadRes.id, path: uploadRes.path }] }],
      settings: {
        __type: 'tiktok',
        title: caption.slice(0, 90),
        privacy_level: 'PUBLIC_TO_EVERYONE',
        duet: true,
        stitch: true,
        comment: true,
        autoAddMusic: 'no',
        brand_content_toggle: false,
        brand_organic_toggle: false,
        video_made_with_ai: false,
        content_posting_method: 'DIRECT_POST',
      },
    }],
  });

  const postRes = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.postiz.com', port: 443, path: '/public/v1/posts', method: 'POST',
      headers: { 'Authorization': POSTIZ_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postPayload) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Postiz post: bad response')); } });
    });
    req.on('error', reject); req.write(postPayload); req.end();
  });

  const postId = Array.isArray(postRes) ? postRes[0]?.postId : postRes?.id;
  return { postId };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🤖 ClipFlow Watcher — ${new Date().toISOString()}`);

  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.error('❌ Missing TG_TOKEN or TG_CHAT_ID'); process.exit(1);
  }

  const state  = loadState();
  const videos = fetchLatestShorts(5);

  if (!videos.length) {
    console.log('⚠️  No videos found — channel fetch failed or empty.');
    return;
  }

  const newVideos = videos.filter(v => !state.seen.includes(v.id));
  console.log(`📺 Found ${videos.length} shorts, ${newVideos.length} new.`);

  if (!newVideos.length) {
    console.log('✅ No new videos. Nothing to do.');
    return;
  }

  for (const video of newVideos) {
    console.log(`\n🎬 Processing: ${video.title} (${video.id})`);

    try {
      // Notify that a new video was found
      await tgSendText(
        `🆕 *New Short detected from ${CHANNEL_URL.split('@')[1]?.split('/')[0] || 'channel'}!*\n\n` +
        `📹 *${video.title}*\n` +
        `📅 Uploaded: ${formatDate(video.timestamp)}\n` +
        `🔗 ${video.url}\n\n` +
        `⏳ Running ClipFlow... dubbing to Spanish 🇪🇸`
      );

      const job = await runClipFlow(video.url);
      const clip = job.clips?.[0];

      if (!clip?.dubbedPath) {
        await tgSendText(`⚠️ ClipFlow finished but no dubbed file found for *${video.title}*`);
        continue;
      }

      // Build caption with titles
      const titles = clip.titles || [];
      const caption =
        `🎬 *${video.title}*\n` +
        `📅 Uploaded: ${formatDate(video.timestamp)}\n` +
        `🔗 ${video.url}\n\n` +
        `📝 *Caption options:*\n` +
        titles.map((t, i) => `${i+1}️⃣ ${t}`).join('\n');

      // Copy dubbed file to a sendable location
      const dest = path.join(__dirname, `${video.id}_es.mp4`);
      fs.copyFileSync(clip.dubbedPath, dest);

      await tgSendVideo(dest, caption);
      console.log(`✅ Sent dubbed video for: ${video.title}`);

      // Cleanup temp file
      try { fs.unlinkSync(dest); } catch {}

      // ── Push to Postiz (TikTok) ───────────────────────────────────────────
      try {
        const bestTitle = titles[0] || video.title;
        const hashtags = '#parati #fyp #viral #tiktoklatino #hispanos #finanzas #dinero #taxes #impuestos #miami #florida';
        const TIKTOK_LIMIT = 150;
        let tiktokCaption = bestTitle + '\n\n';
        for (const tag of hashtags.split(/\s+/)) {
          if ((tiktokCaption + tag).length <= TIKTOK_LIMIT) tiktokCaption += tag + ' ';
          else break;
        }
        tiktokCaption = tiktokCaption.trim();
        if (tiktokCaption.length > TIKTOK_LIMIT)
          tiktokCaption = tiktokCaption.slice(0, TIKTOK_LIMIT).replace(/\s+\S*$/, '').trim();

        const postizResult = await uploadToPostiz(clip.dubbedPath, tiktokCaption);
        console.log(`📱 Pushed to Postiz: postId=${postizResult.postId}`);

        await tgSendText(
          `✅ *Subido a Postiz para TikTok!*\n\n` +
          `📝 *Título usado:* ${bestTitle}\n\n` +
          `📌 Ve a postiz.com → TikTok para revisar y publicar.\n\n` +
          `*Otras opciones de título:*\n` +
          titles.slice(1).map((t, i) => `${i+2}️⃣ ${t}`).join('\n')
        );
      } catch (postizErr) {
        console.error(`⚠️ Postiz upload failed: ${postizErr.message}`);
        await tgSendText(`⚠️ *Postiz upload falló:* ${postizErr.message}\nEl video ya fue enviado por Telegram — puedes subirlo manualmente.`);
      }

      // Mark as seen
      state.seen.push(video.id);
      saveState(state);

    } catch (err) {
      console.error(`❌ Error processing ${video.id}:`, err.message);
      await tgSendText(`❌ Error processing *${video.title}*: ${err.message}`);
      // Mark as seen to avoid retrying a broken video forever
      state.seen.push(video.id);
      saveState(state);
    }
  }

  console.log('\n✅ Watcher done.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
