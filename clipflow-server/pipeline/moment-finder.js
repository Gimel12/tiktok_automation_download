require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Uses Claude Haiku to identify the top viral-worthy moments in a transcript.
 * @param {{ text: string, segments: Array<{start, end, text}> }} transcript
 * @param {number} videoDuration - total video duration in seconds
 * @returns {Array<{ start: number, end: number, reason: string, score: number }>}
 */
async function findViralMoments(transcript, videoDuration) {
  console.log('🔍 Sending transcript to Claude to find viral moments...');

  const { segments } = transcript;

  // Format transcript with timestamps for Claude
  const formattedTranscript = segments
    .map((s) => `[${fmtTime(s.start)} → ${fmtTime(s.end)}] ${s.text}`)
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `You are a viral content strategist specializing in short-form video for TikTok.

Analyze the following video transcript and identify the TOP 3–5 most viral-worthy moments to clip.

Video duration: ${Math.round(videoDuration)}s

Selection criteria:
- Duration: ideally 30–90 seconds. If video is short (<3 min), clips can be 15–90 seconds.
- Self-contained: the clip makes sense without watching the rest
- High viral potential: emotional hook, surprising fact, funny beat, controversy, inspiration, strong takeaway
- Strong opening: starts at an interesting point

TRANSCRIPT:
${formattedTranscript}

Return ONLY a valid JSON array. No markdown, no explanation, just the array:
[
  {
    "start": <float seconds>,
    "end": <float seconds>,
    "reason": "<one sentence explaining the viral hook>",
    "score": <integer 1-10>
  }
]

Requirements:
- Clips must be between 15 and 90 seconds long
- Times must be within the video duration (max: ${Math.round(videoDuration)}s)
- Sort by score descending
- Return 3 to 5 moments`,
      },
    ],
  });

  const raw = response.content[0].text.trim();

  // Extract JSON array from response
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`Claude returned unexpected format for moments:\n${raw}`);
  }

  const moments = JSON.parse(jsonMatch[0]);

  // Validate and filter
  const valid = moments.filter((m) => {
    const dur = m.end - m.start;
    if (typeof m.start !== 'number' || typeof m.end !== 'number') return false;
    if (dur < 10 || dur > 95) {
      console.warn(`  ⚠️  Skipping moment [${fmtTime(m.start)}–${fmtTime(m.end)}]: duration ${Math.round(dur)}s out of range`);
      return false;
    }
    if (m.end > videoDuration + 2) {
      console.warn(`  ⚠️  Skipping moment: end time ${m.end}s exceeds video duration ${videoDuration}s`);
      return false;
    }
    return true;
  });

  if (valid.length === 0) {
    throw new Error('No valid moments found (all were outside 30–90s range)');
  }

  console.log(`✅ Found ${valid.length} viral moments:`);
  valid.forEach((m, i) => {
    console.log(
      `  ${i + 1}. [${fmtTime(m.start)} → ${fmtTime(m.end)}] ` +
        `${Math.round(m.end - m.start)}s | ⭐ ${m.score}/10 — ${m.reason}`
    );
  });

  return valid;
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

module.exports = { findViralMoments };
