require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { execFileSync, execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const OUTPUT_DIR   = process.env.OUTPUT_DIR || './output';
const COOKIES_FILE = process.env.YTDLP_COOKIES || path.join(__dirname, '../cookies.txt');

/**
 * Build yt-dlp auth args.
 * Priority:
 *   1. cookies.txt file (if it exists)
 *   2. --cookies-from-browser chrome
 *   3. no auth (may fail on bot-protected videos)
 */
function authArgs() {
  if (fs.existsSync(COOKIES_FILE)) {
    console.log(`   🍪 Using cookies file: ${COOKIES_FILE}`);
    return ['--cookies', COOKIES_FILE];
  }
  // Try chrome (non-blocking check)
  try {
    execSync('pgrep -x "Google Chrome" > /dev/null 2>&1', { timeout: 2000 });
    // Chrome is running — can't read cookies while open, skip
    console.log('   ⚠️  Chrome is running — cannot read cookies while open. Using cookies.txt fallback.');
  } catch (_) {
    // Chrome not running — safe to read
    console.log('   🍪 Using cookies from Chrome...');
    return ['--cookies-from-browser', 'chrome'];
  }
  return [];
}

/**
 * Downloads a YouTube video using yt-dlp.
 * @param {string} url - YouTube URL
 * @returns {{ videoId, title, duration, filePath }}
 */
async function downloadVideo(url) {
  console.log(`📥 Fetching video info: ${url}`);

  const auth = authArgs();

  // Get video metadata
  const infoRaw = execFileSync('yt-dlp', [
    '--dump-json', '--no-playlist',
    ...auth,
    url,
  ], { encoding: 'utf8' });

  const info     = JSON.parse(infoRaw);
  const videoId  = info.id;
  const title    = info.title;
  const duration = info.duration;

  const videoDir = path.resolve(OUTPUT_DIR, videoId);
  fs.mkdirSync(videoDir, { recursive: true });

  const filePath = path.join(videoDir, 'original.mp4');

  if (fs.existsSync(filePath)) {
    console.log(`✅ Already downloaded, skipping: ${filePath}`);
    return { videoId, title, duration, filePath };
  }

  console.log(`🎬 Downloading "${title}" (${Math.round(duration)}s)...`);

  execFileSync('yt-dlp', [
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
    '--merge-output-format', 'mp4',
    '--write-auto-sub',
    '--sub-lang', 'en',
    '--sub-format', 'vtt',
    '--no-playlist',
    ...auth,
    '-o', filePath,
    url,
  ], { stdio: 'inherit' });

  console.log(`✅ Download complete: ${filePath}`);
  return { videoId, title, duration, filePath };
}

module.exports = { downloadVideo };
