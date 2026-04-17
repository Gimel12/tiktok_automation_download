require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

/**
 * Cuts video moments and converts them to 9:16 vertical format (1080x1920).
 * Scales the source video to fit width=1080, then pads vertically with black bars.
 *
 * @param {Array<{start, end, reason, score}>} moments
 * @param {{ videoId: string, filePath: string }} videoInfo
 * @returns {string[]} array of absolute clip file paths
 */
async function createClips(moments, videoInfo) {
  const { filePath } = videoInfo;
  const videoDir = path.dirname(filePath);

  console.log(`✂️  Creating ${moments.length} clip(s) in 9:16 format (1080×1920)...`);

  const clipPaths = [];

  for (let i = 0; i < moments.length; i++) {
    const moment = moments[i];
    const clipName = `clip_${String(i + 1).padStart(2, '0')}.mp4`;
    const clipPath = path.join(videoDir, clipName);

    const duration = moment.end - moment.start;
    console.log(
      `  🎬 Clip ${i + 1}/${moments.length}: ${clipName} ` +
        `[${fmtTime(moment.start)} → ${fmtTime(moment.end)}] (${Math.round(duration)}s)`
    );

    await cutAndFormat(filePath, clipPath, moment.start, duration);

    console.log(`     ✅ Saved: ${clipPath}`);
    clipPaths.push(clipPath);
  }

  console.log(`✅ All ${clipPaths.length} clips created`);
  return clipPaths;
}

/**
 * Cuts a segment from the source and encodes it to 9:16 1080×1920.
 * The filter pipeline:
 *   1. scale=1080:1920:force_original_aspect_ratio=decrease  → fit within 1080×1920
 *   2. pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black              → center with black bars
 *   3. setsar=1                                              → square pixel aspect ratio
 */
function cutAndFormat(inputPath, outputPath, startSec, durationSec) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startSec)
      .setDuration(durationSec)
      .videoFilters(
        'scale=w=1080:h=1920:force_original_aspect_ratio=decrease,' +
          'pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,' +
          'setsar=1'
      )
      .outputOptions([
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-pix_fmt', 'yuv420p',
      ])
      .output(outputPath)
      .on('error', (err) => {
        console.error(`     ❌ ffmpeg error: ${err.message}`);
        reject(err);
      })
      .on('end', resolve)
      .run();
  });
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

module.exports = { createClips };
