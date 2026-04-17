'use strict';

/**
 * One-shot test: run the full ClipFlow pipeline on a single YouTube URL.
 * Sends result to Telegram and optionally pushes to Buffer as a TikTok draft.
 *
 * Usage:
 *   node test_single.js <youtube-url>
 *
 * Example:
 *   node test_single.js https://www.youtube.com/shorts/abc123
 */

require('dotenv').config({ path: __dirname + '/.env' });

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const CLIPFLOW_API = process.env.CLIPFLOW_API || 'http://localhost:4000';
const TG_TOKEN     = process.env.TG_TOKEN;
const TG_CHAT_ID   = process.env.TG_CHAT_ID;

const videoUrl = process.argv[2];
if (!videoUrl) { console.error('Usage: node test_single.js <youtube-url>'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getPublicBase() {
  const CF_FILE = '/tmp/clipflow_public_url.txt';
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (fs.existsSync(CF_FILE)) {
    const url = fs.readFileSync(CF_FILE, 'utf8').trim();
    if (url.startsWith('http')) return url.replace(/\/$/, '');
  }
  return 'http://localhost:4000';
}

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

// ── ClipFlow ──────────────────────────────────────────────────────────────────
async function runClipFlow(url) {
  const res = await fetch(`${CLIPFLOW_API}/api/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      urls: [url],
      dubSettings: { output_language: 'Spanish', enable_voice_clone: true, caption: true, no_cut: true },
    }),
  });
  const { jobIds } = await res.json();
  const jobId = jobIds?.[0];
  if (!jobId) throw new Error('No job ID returned from ClipFlow');
  console.log(`📋 Job ID: ${jobId}`);

  const start = Date.now();
  while (Date.now() - start < 1200000) {
    await sleep(15000);
    const r   = await fetch(`${CLIPFLOW_API}/api/jobs/${jobId}`);
    const job = await r.json();
    console.log(`   ⏳ [${job.status}] ${job.progress?.label || '...'} ${job.progress?.stepProgress || ''}%`);
    if (job.status === 'done')  return job;
    if (job.status === 'error') throw new Error(job.error || 'ClipFlow pipeline error');
  }
  throw new Error('Timeout — pipeline took over 20 minutes');
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🧪 ClipFlow Test — ${new Date().toISOString()}`);
  console.log(`🔗 URL: ${videoUrl}`);
  console.log(`📡 ClipFlow API: ${CLIPFLOW_API}`);
  console.log(`🌐 Public base: ${getPublicBase()}\n`);

  // Step 1: Notify start
  await tgSendText(
    `🧪 *Test run started!*\n\n` +
    `🔗 ${videoUrl}\n\n` +
    `⏳ Dubbing to Spanish... this takes a few minutes 🇪🇸`
  );

  // Step 2: Run ClipFlow pipeline
  console.log('🎬 Submitting to ClipFlow...');
  let job;
  try {
    job = await runClipFlow(videoUrl);
  } catch (err) {
    await tgSendText(`❌ *ClipFlow failed:* ${err.message}`);
    throw err;
  }

  const clip = job.clips?.[0];
  if (!clip?.dubbedPath) {
    await tgSendText(`⚠️ Pipeline finished but no dubbed file was found.`);
    process.exit(1);
  }

  console.log(`\n✅ Pipeline done!`);
  console.log(`   Dubbed path: ${clip.dubbedPath}`);
  console.log(`   Dubbed URL:  ${clip.dubbedUrl}`);
  console.log(`   Titles:`, clip.titles);

  // Step 3: Send video + titles to Telegram
  const titles = clip.titles || [];
  const tgCaption =
    `✅ *Video doblado listo!*\n\n` +
    `📹 ${videoUrl}\n\n` +
    `📝 *Opciones de título:*\n` +
    titles.map((t, i) => `${i+1}️⃣ ${t}`).join('\n');

  console.log('\n📱 Sending video to Telegram...');
  const tempFile = path.join(__dirname, `test_${Date.now()}_es.mp4`);
  fs.copyFileSync(clip.dubbedPath, tempFile);
  await tgSendVideo(tempFile, tgCaption);
  try { fs.unlinkSync(tempFile); } catch {}
  console.log('   ✅ Telegram video sent');

  console.log('\n🎉 Test complete! Check Telegram for the dubbed video.');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
