# Architecture Deep Dive

## Pipeline Flow

```
1. LaunchAgent fires (daily, staggered times)
        ↓
2. check_channel.js starts
        ↓
3. yt-dlp fetches latest 5 Shorts from YouTube channel
        ↓
4. Compares video IDs against state.json (seen list)
        ↓  (new videos only)
5. POST /api/process to ClipFlow server (localhost:4000)
        ↓
6. ClipFlow server pipeline:
   a. yt-dlp downloads the video
   b. OpenAI Whisper transcribes audio
   c. Claude Haiku detects best clip moments
   d. ffmpeg crops to 9:16 vertical format
   e. HeyGen dubs audio to Spanish + lip sync
   f. Claude Haiku generates 3 viral Spanish titles
        ↓
7. Watcher polls GET /api/jobs/:id every 15 seconds (max 20 min)
        ↓  (job = "done")
8. Sends dubbed video + titles to Telegram
        ↓
9. Uploads video to Postiz
        ↓
10. Postiz schedules post to TikTok (5 min from now)
        ↓
11. Sends Telegram confirmation with title used + alternatives
        ↓
12. Marks video ID as seen in state.json
```

## Components

### ClipFlow Server (`~/Downloads/TikTok Clip Machine/server.js`)
- Express.js app on port 4000
- Job queue system (one job per video)
- Integrates: OpenAI Whisper, HeyGen, Claude Haiku, ffmpeg, yt-dlp
- Exposes:
  - `POST /api/process` — submit video URL(s) for processing
  - `GET /api/jobs/:id` — poll job status and results

### Channel Watchers (`watchers/check_channel.js`)
- One instance per YouTube channel, each in its own folder with its own `.env`
- Reads `state.json` to track seen video IDs (persists across runs)
- Uses `yt-dlp --flat-playlist` for fast channel scanning (no download)
- Submits new videos to ClipFlow server one at a time

### Cloudflare Tunnel
- HeyGen delivers dubbed video files via webhook/callback to your server
- The tunnel gives your localhost:4000 a stable public HTTPS URL
- Configured with a custom domain (clips.yourdomain.com)
- Managed by `com.clipflow.tunnel` LaunchAgent (always-on)

### Postiz Integration
- Videos are uploaded directly from disk (multipart/form-data)
- Post is scheduled 5 minutes in the future
- Settings: PUBLIC_TO_EVERYONE, direct post, duet/stitch/comment on

## State Files

Each watcher folder has a `state.json`:
```json
{
  "seen": ["videoId1", "videoId2", "videoId3"]
}
```

When deployed fresh, `state.json` will be empty (`{ "seen": [] }`).
The first run will process the 5 most recent Shorts. If you don't want
that, pre-populate `state.json` with existing video IDs from the channel.

## Schedule (UTC — adjust for EST/EDT)

| Channel | UTC | ET (EDT/summer) | ET (EST/winter) |
|---|---|---|---|
| @karltondennis | 14:00 | 10:00 AM | 9:00 AM |
| @nischa | 14:30 | 10:30 AM | 9:30 AM |
| @humphrey | 15:00 | 11:00 AM | 10:00 AM |
| @GrahamStephan | 15:30 | 11:30 AM | 10:30 AM |
| @TheRamseyShowEpisodes | 16:00 | 12:00 PM | 11:00 AM |

Watchers are staggered 30 minutes apart so the ClipFlow server isn't
processing multiple videos simultaneously (HeyGen has concurrency limits).
