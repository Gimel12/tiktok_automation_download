'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const COOKIES = process.env.YTDLP_COOKIES || path.join(__dirname, '../cookies.txt');

function authArgs() {
  if (fs.existsSync(COOKIES)) return `--cookies "${COOKIES}"`;
  return '';
}

/**
 * Resolve any YouTube input (handle, video URL, shorts URL, channel URL)
 * Returns { channelUrl, name } or throws
 */
function resolveChannel(input) {
  let url = input.trim();

  // If it's a handle or bare name — convert to channel URL
  if (!url.startsWith('http')) {
    const handle = url.startsWith('@') ? url : '@' + url;
    return { channelUrl: `https://www.youtube.com/${handle}`, name: null };
  }

  // If it's already a channel/user URL — return as-is
  if (url.includes('youtube.com/@') || url.includes('youtube.com/channel/') || url.includes('youtube.com/c/') || url.includes('youtube.com/user/')) {
    return { channelUrl: url.replace(/\/$/, ''), name: null };
  }

  // If it's a video or shorts URL — extract channel from video metadata
  if (url.includes('youtube.com/watch') || url.includes('youtube.com/shorts/') || url.includes('youtu.be/')) {
    const auth = authArgs();
    try {
      const cmd = `yt-dlp ${auth} --dump-json --no-playlist "${url}"`;
      const out = execSync(cmd, { encoding: 'utf8', timeout: 20000, stdio: ['pipe','pipe','pipe'] });
      const d   = JSON.parse(out.trim());
      const channelUrl = d.uploader_url || d.channel_url || null;
      const name       = d.channel || d.uploader || null;
      if (channelUrl) return { channelUrl: channelUrl.replace(/\/$/, ''), name };
    } catch (e) {
      console.error('resolveChannel video error:', e.message.slice(0, 100));
    }
  }

  // Fallback — use as-is
  return { channelUrl: url.replace(/\/$/, ''), name: null };
}

function parseItem(d) {
  return {
    id:        d.id,
    title:     d.title || 'Untitled',
    url:       `https://www.youtube.com/watch?v=${d.id}`,
    duration:  d.duration || null,
    thumbnail: d.thumbnail || `https://i.ytimg.com/vi/${d.id}/mqdefault.jpg`,
    views:     d.view_count || null,
    date:      d.upload_date || null, // YYYYMMDD
  };
}

/**
 * Fetch latest N items (quick mode)
 */
function fetchLatest(channelUrl, type = 'videos', count = 5) {
  const suffix = type === 'shorts' ? '/shorts' : '/videos';
  const base   = channelUrl.replace(/\/(videos|shorts)\/?$/, '');
  const url    = base + suffix;
  const auth   = authArgs();
  const cmd    = `yt-dlp ${auth} --flat-playlist --playlist-end ${count} --dump-json "${url}"`;

  try {
    const output = execSync(cmd, { encoding: 'utf8', timeout: 30000, stdio: ['pipe','pipe','pipe'] });
    return output.trim().split('\n').filter(Boolean).map(line => {
      try { return { ...parseItem(JSON.parse(line)), type }; } catch { return null; }
    }).filter(Boolean);
  } catch (e) {
    console.error(`fetchLatest error: ${e.message.slice(0,200)}`);
    return [];
  }
}

/**
 * Fetch a paginated page of videos (browse mode)
 * start/end are 1-indexed playlist positions
 */
function fetchPage(channelUrl, type = 'videos', start = 1, end = 20, sort = 'newest') {
  const suffix = type === 'shorts' ? '/shorts' : '/videos';
  const base   = channelUrl.replace(/\/(videos|shorts)\/?$/, '');
  let url      = base + suffix;

  const auth = authArgs();

  // For oldest-first we need to reverse — yt-dlp doesn't support this natively
  // so we fetch a big chunk and reverse on our end for small pages,
  // but for large channels we use --playlist-reverse
  const reverseFlag = sort === 'oldest' ? '--playlist-reverse' : '';

  const cmd = `yt-dlp ${auth} --flat-playlist --playlist-start ${start} --playlist-end ${end} ${reverseFlag} --dump-json "${url}"`;

  try {
    const output = execSync(cmd, { encoding: 'utf8', timeout: 45000, stdio: ['pipe','pipe','pipe'] });
    return output.trim().split('\n').filter(Boolean).map(line => {
      try { return { ...parseItem(JSON.parse(line)), type }; } catch { return null; }
    }).filter(Boolean);
  } catch (e) {
    console.error(`fetchPage error: ${e.message.slice(0,200)}`);
    return [];
  }
}

/**
 * Get channel name from a clean channel URL
 */
function getChannelName(channelUrl) {
  const auth = authArgs();
  try {
    const cmd = `yt-dlp ${auth} --flat-playlist --playlist-end 1 --dump-json "${channelUrl}/videos"`;
    const out  = execSync(cmd, { encoding: 'utf8', timeout: 15000, stdio: ['pipe','pipe','pipe'] });
    const d    = JSON.parse(out.trim().split('\n')[0]);
    return d.channel || d.uploader || null;
  } catch { return null; }
}

module.exports = { resolveChannel, fetchLatest, fetchPage, getChannelName };
