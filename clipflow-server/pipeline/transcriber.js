require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Extracts audio from a video and transcribes it.
 * Uses OpenAI Whisper API if OPENAI_API_KEY is set, otherwise falls back to yt-dlp VTT subtitles.
 * @param {{ videoId, filePath }} videoInfo
 * @returns {{ text: string, segments: Array<{start, end, text}> }}
 */
async function transcribeVideo(videoInfo) {
  const { filePath } = videoInfo;
  const videoDir = path.dirname(filePath);
  const audioPath = path.join(videoDir, 'audio.mp3');

  // Extract audio with ffmpeg
  if (!fs.existsSync(audioPath)) {
    console.log('🎵 Extracting audio...');
    execFileSync(
      'ffmpeg',
      [
        '-i', filePath,
        '-vn',
        '-acodec', 'mp3',
        '-ar', '16000',
        '-ac', '1',
        '-q:a', '5',
        '-y',
        audioPath,
      ],
      { stdio: 'inherit' }
    );
    console.log(`✅ Audio extracted: ${audioPath}`);
  } else {
    console.log(`✅ Audio already exists: ${audioPath}`);
  }

  if (process.env.OPENAI_API_KEY) {
    return await transcribeWithWhisper(audioPath);
  } else {
    return transcribeWithVtt(videoDir);
  }
}

// --- OpenAI Whisper ---

async function transcribeWithWhisper(audioPath) {
  console.log('🤖 Transcribing with OpenAI Whisper API...');

  const { OpenAI } = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  });

  const segments = (response.segments || []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));

  const text = response.text || segments.map((s) => s.text).join(' ');
  console.log(`✅ Whisper: ${segments.length} segments transcribed`);
  return { text, segments };
}

// --- VTT subtitle fallback ---

function transcribeWithVtt(videoDir) {
  console.log('📝 Using yt-dlp VTT subtitles as transcription fallback...');

  const files = fs.readdirSync(videoDir);
  const vttFile = files.find((f) => f.endsWith('.vtt'));

  if (!vttFile) {
    throw new Error(
      '❌ No VTT subtitle file found and OPENAI_API_KEY is not set.\n' +
        'Set OPENAI_API_KEY in .env or ensure the video has auto-generated captions.'
    );
  }

  const vttPath = path.join(videoDir, vttFile);
  console.log(`📄 Parsing VTT: ${vttFile}`);

  const content = fs.readFileSync(vttPath, 'utf8');
  const segments = parseVtt(content);

  const text = segments.map((s) => s.text).join(' ');
  console.log(`✅ VTT: ${segments.length} segments parsed`);
  return { text, segments };
}

/**
 * Parses a WebVTT string into segment objects.
 * Handles YouTube auto-generated VTT quirks (inline timestamps, duplicate lines, tags).
 */
function parseVtt(content) {
  const segments = [];
  const seen = new Set();

  // Split into cue blocks (separated by blank lines)
  const blocks = content.split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    // Find the timestamp line
    const tsLine = lines.find((l) => l.includes('-->'));
    if (!tsLine) continue;

    const [startRaw, , endRaw] = tsLine.split(/\s+/);
    const start = parseVttTime(startRaw);
    const end = parseVttTime(endRaw);
    if (isNaN(start) || isNaN(end)) continue;

    // Collect text lines (after timestamp line), strip VTT tags
    const textLines = lines
      .slice(lines.indexOf(tsLine) + 1)
      .map((l) => l.replace(/<[^>]+>/g, '').trim())
      .filter((l) => l.length > 0 && !l.match(/^\d+$/)); // skip cue numbers

    const text = textLines.join(' ').trim();
    if (!text) continue;

    // Deduplicate overlapping cues (YouTube repeats lines)
    const key = `${Math.round(start)}-${text}`;
    if (seen.has(key)) continue;
    seen.add(key);

    segments.push({ start, end, text });
  }

  return segments;
}

/** Converts VTT timestamp (HH:MM:SS.mmm or MM:SS.mmm) to seconds. */
function parseVttTime(ts) {
  if (!ts) return NaN;
  const clean = ts.split(' ')[0]; // strip position modifiers
  const parts = clean.split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return NaN;
}

module.exports = { transcribeVideo };
