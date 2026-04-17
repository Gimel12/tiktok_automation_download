require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { downloadVideo } = require('./downloader');
const { transcribeVideo } = require('./transcriber');
const { findViralMoments } = require('./moment-finder');
const { createClips } = require('./clipper');
const { dubClip } = require('./dubber');
const { generateTitles } = require('./title-generator');

/**
 * Orchestrates the full TikTok Clip Machine pipeline.
 *
 * Pipeline:
 *   1. Download  → yt-dlp downloads video + VTT subtitles
 *   2. Transcribe → ffmpeg audio extraction + Whisper API (or VTT fallback)
 *   3. Moments   → Claude Haiku finds top 3–5 viral moments (30–90s each)
 *   4. Clip      → fluent-ffmpeg cuts & converts to 9:16 1080×1920
 *   5. Titles    → Claude Haiku generates 3 viral Spanish titles per clip
 *
 * @param {string} url - YouTube URL
 * @param {string} [jobId] - optional job ID (used by server for progress tracking)
 * @param {Function} [onProgress] - optional callback({ step, stepIndex, totalSteps, stepProgress, label, status })
 * @returns {{
 *   videoId: string,
 *   title: string,
 *   clips: Array<{
 *     clipPath: string,
 *     start: number,
 *     end: number,
 *     reason: string,
 *     score: number,
 *     titles: string[]
 *   }>
 * }}
 */
async function processVideo(url, jobId, onProgress, dubSettings = {}) {
  const startTime = Date.now();
  const divider = '─'.repeat(60);
  const notify = onProgress || (() => {});

  const STEPS = [
    { id: 'download',   label: 'Descargando video',           index: 0 },
    { id: 'transcribe', label: 'Transcribiendo audio',        index: 1 },
    { id: 'analyze',    label: 'Analizando momentos virales', index: 2 },
    { id: 'clip',       label: 'Recortando clips',            index: 3 },
    { id: 'dub',        label: 'Doblando al español',         index: 4 },
    { id: 'titles',     label: 'Generando títulos virales',   index: 5 },
  ];
  const totalSteps = STEPS.length;

  function progress(step, stepProgress, status = 'running') {
    notify({ ...step, totalSteps, stepProgress, status });
  }

  console.log('\n🚀 TikTok Clip Machine — Pipeline starting');
  console.log(divider);
  console.log(`🔗 URL: ${url}`);
  if (jobId) console.log(`🆔 Job: ${jobId}`);
  console.log(divider);

  // ── Step 1: Download ────────────────────────────────────────────────────────
  const step1 = STEPS[0];
  progress(step1, 0);
  console.log('\n📥 STEP 1/5 — Download');

  const videoInfo = await downloadVideo(url);
  console.log(`   ✅ "${videoInfo.title}" | ${Math.round(videoInfo.duration)}s\n`);
  progress(step1, 100, 'done');

  // ── Step 2: Transcribe ───────────────────────────────────────────────────────
  const step2 = STEPS[1];
  progress(step2, 0);
  console.log('📝 STEP 2/5 — Transcribe');

  const transcript = await transcribeVideo(videoInfo);
  console.log(
    `   ✅ ${transcript.segments.length} segments | ${transcript.text.length} chars\n`
  );
  progress(step2, 100, 'done');

  // ── Step 3 & 4: Find moments + clip (or skip if no_cut) ─────────────────────
  let moments, clipPaths;

  if (dubSettings.no_cut) {
    // Skip AI moment detection and clipping — process full video as one clip
    console.log('🎬 NO-CUT MODE — Skipping moments & clipping, using full video');
    const step3 = STEPS[2]; progress(step3, 0);
    moments = [{ start: 0, end: videoInfo.duration, reason: 'Full video (no-cut mode)', score: 10 }];
    progress(step3, 100, 'done');
    const step4 = STEPS[3]; progress(step4, 0);
    clipPaths = [videoInfo.filePath];
    progress(step4, 100, 'done');
    console.log(`   ✅ Full video used as single clip (${Math.round(videoInfo.duration)}s)\n`);
  } else {
    // Normal flow: find viral moments then cut clips
    const step3 = STEPS[2];
    progress(step3, 0);
    console.log('🔍 STEP 3/5 — Find viral moments');
    moments = await findViralMoments(transcript, videoInfo.duration);
    console.log(`   ✅ ${moments.length} moments identified\n`);
    progress(step3, 100, 'done');

    const step4 = STEPS[3];
    progress(step4, 0);
    console.log('✂️  STEP 4/5 — Create clips');
    clipPaths = await createClips(moments, videoInfo);
    console.log(`   ✅ ${clipPaths.length} clips created\n`);
    progress(step4, 100, 'done');
  }

  // ── Step 5: Dub clips to Spanish ─────────────────────────────────────────────
  const step5 = STEPS[4];
  progress(step5, 0);
  console.log('\n🎙️  STEP 5/6 — Dub clips to Spanish (ElevenLabs)');

  const videoDir = require('path').dirname(videoInfo.filePath);
  const dubbedPaths = [];
  for (let i = 0; i < clipPaths.length; i++) {
    console.log(`  Dubbing clip ${i + 1}/${clipPaths.length}...`);
    const dubbed = await dubClip(clipPaths[i], videoDir, i, dubSettings);
    dubbedPaths.push(dubbed ? dubbed.dubbedPath : null);
    progress(step5, Math.round(((i + 1) / clipPaths.length) * 100));
  }
  progress(step5, 100, 'done');

  // ── Step 6: Generate Spanish titles ─────────────────────────────────────────
  const step6 = STEPS[5];
  progress(step6, 0);
  console.log('🇪🇸 STEP 6/6 — Generate Spanish titles');

  const clips = [];
  for (let i = 0; i < moments.length; i++) {
    const titles = await generateTitles(moments[i], i, videoInfo.title);
    clips.push({
      clipPath: clipPaths[i],
      dubbedPath: dubbedPaths[i] || null,
      start: moments[i].start,
      end: moments[i].end,
      reason: moments[i].reason,
      score: moments[i].score,
      titles,
      videoTitle: videoInfo.title,
      transcriptSnippet: transcript?.text?.slice(0, 800) || '',
    });
    progress(step6, Math.round(((i + 1) / moments.length) * 100));
  }

  progress(step6, 100, 'done');

  // ── Summary ──────────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${divider}`);
  console.log(`🎉 Pipeline complete! (${elapsed}s)`);
  console.log(divider);
  console.log(`📹 Video: "${videoInfo.title}"`);
  console.log(`🆔 ID: ${videoInfo.videoId}`);
  console.log(`📦 ${clips.length} clips ready:\n`);

  clips.forEach((clip, i) => {
    const dur = Math.round(clip.end - clip.start);
    console.log(`  Clip ${i + 1} — ${dur}s | ⭐ ${clip.score}/10`);
    console.log(`  📌 ${clip.reason}`);
    console.log(`  📁 ${clip.clipPath}`);
    console.log('  🇪🇸 Títulos:');
    clip.titles.forEach((t) => console.log(`     • ${t}`));
    console.log();
  });

  // ── Step 7: Auto-organize into output_organized/ ─────────────────────────────
  try {
    const fs = require('fs');
    const pathLib = require('path');
    const ORGANIZED_DIR = pathLib.join(__dirname, '../output_organized');

    // Derive channel name from job context (passed via dubSettings or env)
    const channelName = dubSettings.channelName || 'Other';
    const channelDir = pathLib.join(ORGANIZED_DIR, channelName);

    // Find next available day number for this channel
    let dayNum = 1;
    if (fs.existsSync(channelDir)) {
      const existing = fs.readdirSync(channelDir).filter(f => f.startsWith('Day'));
      dayNum = existing.length + 1;
    }

    for (const clip of clips) {
      if (!clip.dubbedPath || !fs.existsSync(clip.dubbedPath)) continue;

      const spanishTitle = clip.titles[0] || videoInfo.title;
      const enClean = videoInfo.title.replace(/[\/\\:*?"<>|#]/g, '').trim().slice(0, 60);
      const esClean = spanishTitle.replace(/[\/\\:*?"<>|#]/g, '').trim().slice(0, 60);
      const dayFolder = pathLib.join(channelDir, 'Day ' + String(dayNum).padStart(2, '0'));
      fs.mkdirSync(dayFolder, { recursive: true });

      const destName = `Day${String(dayNum).padStart(2, '0')} - ${enClean} - ${esClean}.mp4`;
      const destPath = pathLib.join(dayFolder, destName);
      fs.copyFileSync(clip.dubbedPath, destPath);
      console.log(`   📁 Organized → ${channelName}/Day${String(dayNum).padStart(2,'0')} - ${enClean.slice(0,30)}...`);
      dayNum++;
    }
  } catch (e) {
    console.warn('   ⚠️  Could not auto-organize clip:', e.message);
  }

  return {
    videoId: videoInfo.videoId,
    title: videoInfo.title,
    clips,
  };
}

module.exports = { processVideo };

// ── CLI entry point ────────────────────────────────────────────────────────────
if (require.main === module) {
  const url = process.argv[2];

  if (!url) {
    console.error('❌ Usage: node pipeline/processor.js <youtube-url>');
    process.exit(1);
  }

  processVideo(url)
    .then((result) => {
      console.log(`\n✅ Done! ${result.clips.length} clips generated for "${result.title}"`);
    })
    .catch((err) => {
      console.error('\n❌ Pipeline failed:', err.message || err);
      process.exit(1);
    });
}
