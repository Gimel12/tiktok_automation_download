# API Keys Guide

## Keys for the ClipFlow Server

These go in `~/Downloads/TikTok Clip Machine/.env`.

### ANTHROPIC_API_KEY
- **Used for:** Generating 3 viral Spanish titles per video (Claude Haiku)
- **Get it:** https://console.anthropic.com → API Keys
- **Cost:** Very cheap — Claude Haiku costs ~$0.00025 per title generation

### OPENAI_API_KEY
- **Used for:** Transcribing video audio (Whisper)
- **Get it:** https://platform.openai.com → API Keys
- **Cost:** ~$0.006/min of audio (Whisper)
- **Note:** This key is also set directly in the server's LaunchAgent plist

### HEYGEN_API_KEY
- **Used for:** Dubbing video to Spanish + lip sync
- **Get it:** https://app.heygen.com → Settings → API
- **Cost:** Varies by plan — the most expensive part of the pipeline
- **Note:** HeyGen needs a public URL to deliver results (Cloudflare tunnel)

---

## Keys for the Watchers

These go in each channel's `.env` file.

### POSTIZ_API_KEY
- **Used for:** Uploading and scheduling TikTok posts
- **Get it:** https://postiz.com → Settings → Developers → API Keys
- **Same key** used across all watchers

### POSTIZ_TIKTOK_ID
- **Used for:** Identifying which TikTok account to post to
- **Get it:** Run `bash scripts/get_postiz_integrations.sh` with your Postiz key
- **Same ID** used across all watchers (one TikTok account)

### TG_TOKEN (Telegram Bot Token)
- **Used for:** Sending you video notifications + the dubbed video file
- **Get it:**
  1. Open Telegram → search @BotFather
  2. Send `/newbot`
  3. Follow the prompts — you'll get a token like `1234567890:AABBcc...`

### TG_CHAT_ID (Your Telegram User ID)
- **Used for:** Knowing which chat to send messages to
- **Get it:**
  1. Open Telegram → search @userinfobot
  2. Send `/start`
  3. It replies with your user ID (a number like `544344605`)

---

## yt-dlp Cookies (Optional)

- **Used for:** Downloading age-restricted or region-locked YouTube videos
- **How to export:**
  1. Install the "Get cookies.txt LOCALLY" Chrome extension
  2. Go to YouTube while logged in
  3. Click the extension → Export cookies → save as `cookies.txt`
  4. Set `COOKIES_FILE=/path/to/cookies.txt` in each watcher's `.env`
