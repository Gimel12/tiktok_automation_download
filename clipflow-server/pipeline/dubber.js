'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const { execSync } = require('child_process');
const heygenState = require('./heygen-state');

const HEYGEN_API_KEY  = process.env.HEYGEN_API_KEY;
const POLL_INTERVAL   = 8000;   // 8s
const POLL_TIMEOUT    = 900000; // 15 min

/**
 * Dubs a clip to Spanish using HeyGen Video Translation:
 *  1. Upload video to HeyGen (upload.heygen.com/v1/asset)
 *  2. Submit translation job (Spanish, voice clone, lip sync, captions)
 *  3. Poll until done
 *  4. Download dubbed MP4 + SRT captions
 *  5. Burn captions (TikTok-style) with ffmpeg
 */
async function dubClip(clipPath, outputDir, clipIndex, settings = {}) {
  if (!HEYGEN_API_KEY) {
    console.warn('  ⚠️  HEYGEN_API_KEY not set — skipping dubbing');
    return null;
  }

  const clipName    = `clip_${String(clipIndex + 1).padStart(2, '0')}`;
  const dubbedPath  = path.join(outputDir, `${clipName}_es.mp4`);
  const captionPath = path.join(outputDir, `${clipName}_es.srt`);

  if (fs.existsSync(dubbedPath)) {
    console.log(`  ✅ Already dubbed: ${path.basename(dubbedPath)}`);
    return { dubbedPath, captionPath: fs.existsSync(captionPath) ? captionPath : null };
  }

  console.log(`  🎬 HeyGen: ${path.basename(clipPath)} → Spanish (voice clone + lip sync)...`);

  try {
    // 1. Upload video to HeyGen
    const sizeMB = (fs.statSync(clipPath).size / 1024 / 1024).toFixed(1);
    console.log(`    [1/4] Uploading ${sizeMB} MB to HeyGen...`);
    const { id: assetId, url: assetUrl } = await uploadAsset(clipPath);
    console.log(`          Asset ID: ${assetId}`);

    // 2. Submit translation
    console.log('    [2/4] Submitting translation...');
    console.log(`          Language: ${settings.output_language || 'Spanish'} | Voice clone: ${settings.enable_voice_clone !== false} | Lip sync: ${!settings.translate_audio_only}`);
    const translateId = await submitTranslation(assetUrl, settings);
    console.log(`          Job ID: ${translateId}`);

    // 3. Poll until done — persist job ID so we can resume if server restarts
    console.log('    [3/4] Processing (this takes 2-5 min per clip)...');
    heygenState.saveJob(null, clipIndex, translateId, dubbedPath, captionPath, settings);
    const { url: dubbedUrl, caption_url } = await pollUntilDone(translateId);
    heygenState.completeJob(translateId);

    // 4. Download results
    console.log('    [4/4] Downloading...');
    await downloadToFile(dubbedUrl, dubbedPath);
    console.log(`          ✅ Dubbed video downloaded`);

    // Skip watermark crop if audio-only (no video was processed)
    if (settings.translate_audio_only) {
      console.log('          ℹ️  Audio-only mode — skipping watermark crop');
    }
    // Remove HeyGen watermark by cropping bottom black bar
    if (!settings.translate_audio_only) {
    console.log('          ✂️  Removing watermark (cropping bottom bar)...');
    try {
      removeWatermark(dubbedPath);
      console.log('          ✅ Watermark removed');
    } catch (e) {
      console.warn(`          ⚠️  Watermark crop failed: ${e.message}`);
    }
    } // end !audio_only

    let finalCaptionPath = null;
    if (caption_url) {
      await downloadToFile(caption_url, captionPath);
      console.log(`          ✅ Spanish captions saved`);
      finalCaptionPath = captionPath;

      // Burn subtitles TikTok-style
      const burnedPath = path.join(outputDir, `${clipName}_es_sub.mp4`);
      try {
        burnSubtitles(dubbedPath, captionPath, burnedPath);
        fs.renameSync(burnedPath, dubbedPath);
        console.log('          ✅ Subtitles burned in (TikTok style)');
      } catch (e) {
        console.warn(`          ⚠️  Subtitle burn skipped: ${e.message}`);
        if (fs.existsSync(burnedPath)) fs.unlinkSync(burnedPath);
      }
    }

    console.log(`  🎉 Done: ${path.basename(dubbedPath)}`);
    return { dubbedPath, captionPath: finalCaptionPath };

  } catch (err) {
    // If HeyGen can't detect a speaker, retry in audio-only mode (more lenient)
    if (err.message && err.message.includes('No speaker is detected') && !settings.translate_audio_only) {
      console.warn(`  ⚠️  No speaker detected — retrying in audio-only mode (no lip sync)...`);
      return dubClip(clipPath, outputDir, clipIndex, { ...settings, translate_audio_only: true, enable_voice_clone: false });
    }
    console.error(`  ❌ HeyGen failed for clip ${clipIndex + 1}: ${err.message}`);
    return null;
  }
}

// Resume a pending HeyGen job by translateId (called on server startup)
async function resumeDubJob(translateId, dubbedPath, captionPath, settings = {}) {
  console.log(`  🔄 Resuming HeyGen job: ${translateId}`);
  try {
    const { url: dubbedUrl, caption_url } = await pollUntilDone(translateId);
    heygenState.completeJob(translateId);

    await downloadToFile(dubbedUrl, dubbedPath);
    if (!settings.translate_audio_only) {
      try { removeWatermark(dubbedPath); } catch {}
    }
    if (caption_url && captionPath) {
      await downloadToFile(caption_url, captionPath);
      const burnedPath = dubbedPath + '.sub.mp4';
      try {
        burnSubtitles(dubbedPath, captionPath, burnedPath);
        fs.renameSync(burnedPath, dubbedPath);
      } catch {}
    }
    console.log(`  ✅ Resumed & downloaded: ${path.basename(dubbedPath)}`);
    return dubbedPath;
  } catch (e) {
    console.error(`  ❌ Resume failed for ${translateId}: ${e.message}`);
    heygenState.completeJob(translateId); // remove stale entry
    return null;
  }
}

// ── 1. Upload asset — raw binary to upload.heygen.com ─────────────────
function uploadAsset(filePath) {
  return new Promise((resolve, reject) => {
    const buf = fs.readFileSync(filePath);
    const req = https.request({
      hostname: 'upload.heygen.com',
      path: '/v1/asset',
      method: 'POST',
      headers: {
        'X-Api-Key': HEYGEN_API_KEY,
        'Content-Type': 'video/mp4',
        'Content-Length': buf.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code !== 100) return reject(new Error(`Upload error: ${data.slice(0,300)}`));
          const id  = json.data?.id;
          const url = json.data?.url;
          if (!id) return reject(new Error(`No asset ID: ${data.slice(0,300)}`));
          resolve({ id, url });
        } catch {
          reject(new Error(`Upload invalid JSON: ${data.slice(0,200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// ── 2. Submit translation ──────────────────────────────────────────────
async function submitTranslation(videoUrl, settings = {}) {
  const res = await heygenPost('/v2/video_translate', {
    video_url:            videoUrl,
    output_language:      settings.output_language      || 'Spanish',
    translate_audio_only: settings.translate_audio_only || false,
    enable_voice_clone:   settings.enable_voice_clone   !== false,
    caption:              settings.caption               !== false,
    speaker_num:          settings.speaker_num           || 0,
  });
  if (res.error) throw new Error(`Translation error: ${JSON.stringify(res.error)}`);
  const id = res.data?.video_translate_id;
  if (!id) throw new Error(`No translate ID: ${JSON.stringify(res)}`);
  return id;
}

// ── 3. Poll status ─────────────────────────────────────────────────────
async function pollUntilDone(translateId) {
  const start = Date.now();
  let tick = 0;
  while (true) {
    if (Date.now() - start > POLL_TIMEOUT) throw new Error('Timed out after 10 min');

    const res    = await heygenGet(`/v2/video_translate/${translateId}`);
    const data   = res.data || {};
    const status = data.status || 'unknown';
    const sp     = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'][tick++ % 10];
    process.stdout.write(`\r          ${sp} ${status}...   `);

    if (status === 'completed' || status === 'success') {
      process.stdout.write('\n');
      if (!data.url) throw new Error('No video URL in completed response');
      return { url: data.url, caption_url: data.caption_url || null };
    }
    if (status === 'failed' || status === 'error') {
      process.stdout.write('\n');
      throw new Error(`HeyGen failed: ${data.message || 'unknown reason'}`);
    }
    await sleep(POLL_INTERVAL);
  }
}

// ── Remove HeyGen watermark by cropping black bars ────────────────────
// HeyGen outputs 1080x1920 with the video letterboxed in the middle.
// The watermark lives in the bottom black bar.
// We: 1) auto-detect content area, 2) crop to content, 3) re-pad to 9:16
function removeWatermark(videoPath) {
  const tmpPath = videoPath + '.nowm.mp4';

  // Step 1: Auto-detect crop area (skip first 2s to avoid fade-in)
  let cropLine = '';
  try {
    const result = execSync(
      `ffmpeg -ss 2 -i "${videoPath}" -t 4 -vf cropdetect=24:16:0 -f null - 2>&1 | grep "crop=" | tail -1`,
      { encoding: 'utf8', shell: true }
    );
    cropLine = result.match(/crop=(\d+:\d+:\d+:\d+)/)?.[1] || '';
  } catch (_) {}

  if (!cropLine) {
    // Fallback: known HeyGen layout — video in center, crop off bottom bar
    // 1080x1920 total, watermark bar is ~200px at bottom, content ~y300-1750
    cropLine = '1080:1440:0:240';
  }

  const [w, h, x, y] = cropLine.split(':').map(Number);
  console.log(`          📐 Crop: ${w}x${h} at ${x},${y}`);

  // Step 2: Crop to content area, then re-scale/pad back to 1080x1920 (9:16)
  execSync(
    `ffmpeg -y -i "${videoPath}" ` +
    `-vf "crop=${w}:${h}:${x}:${y},` +
    `scale=1080:1920:force_original_aspect_ratio=decrease,` +
    `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black" ` +
    `-c:v libx264 -preset fast -crf 22 -c:a copy "${tmpPath}"`,
    { stdio: 'pipe' }
  );

  // Replace original with watermark-free version
  fs.renameSync(tmpPath, videoPath);
}

// ── 4. Burn subtitles (TikTok style) ──────────────────────────────────
function burnSubtitles(videoPath, srtPath, outputPath) {
  // White bold text, dark background, bottom-center — classic TikTok style
  const escaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  execSync(
    `ffmpeg -y -i "${videoPath}" ` +
    `-vf "subtitles='${escaped}':force_style='` +
      `FontName=Arial,FontSize=17,Bold=1,` +
      `PrimaryColour=&H00FFFFFF,` +
      `OutlineColour=&H00000000,Outline=2,` +
      `BackColour=&H80000000,BorderStyle=3,` +
      `Alignment=2,MarginV=45'" ` +
    `-c:v libx264 -preset fast -crf 22 -c:a copy "${outputPath}"`,
    { stdio: 'pipe' }
  );
}

// ── HTTP helpers ───────────────────────────────────────────────────────
function heygenPost(endpoint, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.heygen.com',
      path: endpoint,
      method: 'POST',
      headers: {
        'X-Api-Key': HEYGEN_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`HeyGen POST invalid JSON: ${data.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function heygenGet(endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.heygen.com',
      path: endpoint,
      method: 'GET',
      headers: { 'X-Api-Key': HEYGEN_API_KEY },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`HeyGen GET invalid JSON: ${data.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function downloadToFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadToFile(res.headers.location, outputPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        let e = '';
        res.on('data', c => e += c);
        res.on('end', () => reject(new Error(`Download HTTP ${res.statusCode}: ${e.slice(0,200)}`)));
        return;
      }
      const file = fs.createWriteStream(outputPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { dubClip, resumeDubJob };
