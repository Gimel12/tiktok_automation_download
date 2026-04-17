# ClipFlow TikTok Automation

Watches YouTube Shorts from multiple channels, auto-dubs them to Spanish using HeyGen, generates viral Spanish titles with Claude, and schedules them to TikTok via Postiz — all running automatically on your Mac every morning.

---

## How It Works

```
YouTube Channels
    ↓  (yt-dlp detects new Shorts daily via macOS LaunchAgents)
ClipFlow Server  [localhost:4000]
    ↓  download → transcribe (Whisper) → dub to Spanish (HeyGen) → generate titles (Claude)
Postiz API
    ↓  schedules to TikTok (5 min from now)
Telegram Bot
    ↓  sends you the dubbed video + 3 title options
```

**Three components:**
| Component | What it does |
|---|---|
| **ClipFlow Server** | Express.js app — does all the heavy lifting (download, transcribe, dub, title) |
| **Channel Watchers** | One Node.js script per YouTube channel — detects new videos |
| **macOS LaunchAgents** | Runs everything automatically (server always on, watchers daily) |

---

## Channels Currently Configured

| Channel | Handle | Daily Run (ET) |
|---|---|---|
| Karl Tondennis | @karltondennis | 9:00 AM |
| Nischa | @nischa | 9:30 AM |
| Humphrey | @humphrey | 10:00 AM |
| Graham Stephan | @GrahamStephan | 10:30 AM |
| The Ramsey Show | @TheRamseyShowEpisodes | 11:00 AM |

---

## Prerequisites

Install on your Mac:

```bash
# Node.js 18+
brew install node

# ffmpeg (video processing)
brew install ffmpeg

# yt-dlp (YouTube downloader)
brew install yt-dlp

# Cloudflare tunnel (so HeyGen can deliver dubbed videos back)
brew install cloudflare/cloudflare/cloudflared
```

---

## API Keys You Need

Collect all of these before starting:

| Key | Purpose | Where to get |
|---|---|---|
| `ANTHROPIC_API_KEY` | Viral title generation (Claude Haiku) | console.anthropic.com |
| `OPENAI_API_KEY` | Audio transcription (Whisper) | platform.openai.com |
| `HEYGEN_API_KEY` | Spanish dubbing + lip sync | app.heygen.com → Settings → API |
| `POSTIZ_API_KEY` | Schedule posts to TikTok | postiz.com → Settings → Developers |
| `POSTIZ_TIKTOK_ID` | Your TikTok channel ID in Postiz | See step 5 below |
| `TG_BOT_TOKEN` | Telegram notifications | @BotFather on Telegram |
| `TG_CHAT_ID` | Your Telegram user ID | @userinfobot on Telegram |

---

## Setup & Deployment (Fresh Mac)

### Step 1 — Clone this repo

```bash
git clone https://github.com/Gimel12/tiktok_automation_download.git
cd tiktok_automation_download
```

### Step 2 — Set up the ClipFlow Server

The ClipFlow server is a separate Express.js app. Place it at:
```
~/Downloads/TikTok Clip Machine/
```

It must have a `.env` file. Use the template:
```bash
cp docs/server-env-template.txt ~/Downloads/"TikTok Clip Machine"/.env
# Edit the file and fill in all API keys
```

Then install its dependencies:
```bash
cd ~/Downloads/"TikTok Clip Machine"
npm install
```

### Step 3 — Set up Cloudflare Tunnel

HeyGen needs a public URL to deliver dubbed videos back to your Mac.

```bash
# One-time: authenticate
cloudflared tunnel login

# Create the tunnel
cloudflared tunnel create clipflow
# Note the TUNNEL_ID printed — you'll need it next

# Create the config file
mkdir -p ~/.cloudflared
cp cloudflare/clipflow-tunnel.yml.example ~/.cloudflared/clipflow-tunnel.yml
# Edit ~/.cloudflared/clipflow-tunnel.yml and fill in YOUR_TUNNEL_ID and your domain
```

Add a CNAME record in your Cloudflare DNS:
```
clips.yourdomain.com  →  YOUR_TUNNEL_ID.cfargotunnel.com
```

### Step 4 — Find Your Postiz TikTok Integration ID

```bash
POSTIZ_API_KEY=your_key bash scripts/get_postiz_integrations.sh
# Copy the ID for your TikTok account
```

### Step 5 — Deploy the Watchers

Run the deploy script to create all watcher folders and LaunchAgent plists automatically:

```bash
python3 scripts/deploy_watchers.py \
  --channels "@karltondennis" "@nischa" "@humphrey" "@GrahamStephan" "@TheRamseyShowEpisodes" \
  --tg-token "YOUR_TG_BOT_TOKEN" \
  --tg-chat-id "YOUR_TELEGRAM_CHAT_ID" \
  --postiz-key "YOUR_POSTIZ_API_KEY" \
  --postiz-tiktok-id "YOUR_POSTIZ_TIKTOK_INTEGRATION_ID" \
  --output-dir ~/clipflow_watchers \
  --server-dir ~/Downloads/"TikTok Clip Machine" \
  --openai-key "YOUR_OPENAI_API_KEY"
```

Then install dependencies in each watcher:
```bash
for dir in ~/clipflow_watchers/clipflow_watcher_*/; do
  (cd "$dir" && npm install)
done
```

### Step 6 — Install LaunchAgents (auto-start everything)

```bash
# Copy server and tunnel plists (edit paths/keys in them first)
cp launchagents/com.ruben.clipflow-server.plist ~/Library/LaunchAgents/
cp launchagents/com.clipflow.tunnel.plist ~/Library/LaunchAgents/
# Edit both files: replace YOUR_USERNAME and YOUR_OPENAI_API_KEY

# Load everything
python3 scripts/install_launchagents.py
launchctl load ~/Library/LaunchAgents/com.clipflow.tunnel.plist
```

### Step 7 — Verify

```bash
# Check server is running
curl http://localhost:4000

# Check tunnel is up
curl https://clips.yourdomain.com

# Check all LaunchAgents loaded
launchctl list | grep clipflow

# Test a watcher manually (runs it right now, won't wait for schedule)
node ~/clipflow_watchers/clipflow_watcher_graham_stephan/check_channel.js
```

---

## Testing a Single Video

Use `test_single.js` to run the full pipeline on one specific YouTube URL without waiting for the scheduled run:

```bash
cd ~/clipflow_watchers/clipflow_watcher_graham_stephan
node ../../tiktok_automation_download/watchers/test_single.js https://www.youtube.com/shorts/VIDEO_ID
```

This will:
1. Send a Telegram message that the test started
2. Submit the video to ClipFlow
3. Poll until done (~5–15 min)
4. Send the dubbed video + 3 Spanish titles to Telegram

---

## Adding a New Channel

```bash
python3 scripts/deploy_watchers.py \
  --channels "@NewChannel" \
  --tg-token "YOUR_TG_BOT_TOKEN" \
  --tg-chat-id "YOUR_TELEGRAM_CHAT_ID" \
  --postiz-key "YOUR_POSTIZ_API_KEY" \
  --postiz-tiktok-id "YOUR_POSTIZ_TIKTOK_INTEGRATION_ID" \
  --output-dir ~/clipflow_watchers

cd ~/clipflow_watchers/clipflow_watcher_new_channel && npm install
launchctl load ~/Library/LaunchAgents/com.ruben.clipflow-watcher-new-channel.plist
```

---

## Monitoring

| What | Command |
|---|---|
| Server logs | `tail -f /tmp/clipflow_server.log` |
| Tunnel logs | `tail -f /tmp/clipflow-tunnel.log` |
| Watcher logs | `tail -f /tmp/clipflow_watcher_CHANNEL.log` |
| All running agents | `launchctl list \| grep clipflow` |
| Kill & restart server | `pkill -f "TikTok Clip Machine/server.js"` |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `fetch failed` on watcher | ClipFlow server is down — check `/tmp/clipflow_server.log` |
| `No speaker detected` | Short clip has no voice — rare, skip it |
| `401 OpenAI` | API key stale in launchctl — run `launchctl setenv OPENAI_API_KEY newkey` and restart server plist |
| Multiple server processes | `pkill -f "TikTok Clip Machine/server.js"` then `launchctl start com.ruben.clipflow-server` |
| HeyGen job stuck on startup | `echo '{}' > ~/Downloads/"TikTok Clip Machine"/heygen_jobs.json` |
| Tunnel won't start | Run `cloudflared tunnel run clipflow` manually to see the error |
| Watcher not running on schedule | Check `launchctl list \| grep clipflow` — if PID is `-`, it's not loaded |

---

## Repo Structure

```
tiktok_automation_download/
├── README.md                        ← You are here
├── .gitignore
│
├── watchers/                        ← Core watcher code (shared by all channels)
│   ├── check_channel.js             ← Main daily watcher script
│   ├── test_single.js               ← One-shot test for any YouTube URL
│   ├── package.json
│   └── .env.example                 ← Template — copy to each channel folder as .env
│
├── channels/                        ← Per-channel .env config files
│   ├── karltondennis/.env
│   ├── ramsey/.env
│   ├── humphrey/.env
│   ├── graham/.env
│   └── nischa/.env
│
├── scripts/
│   ├── deploy_watchers.py           ← Auto-creates all watcher folders + plist files
│   ├── install_launchagents.py      ← Loads/unloads all LaunchAgents
│   └── get_postiz_integrations.sh   ← Looks up your Postiz TikTok integration ID
│
├── launchagents/
│   ├── com.ruben.clipflow-server.plist   ← Keeps server running (edit paths before use)
│   ├── com.clipflow.tunnel.plist         ← Keeps Cloudflare tunnel running
│   └── watcher-template.plist            ← Template for channel watchers
│
├── cloudflare/
│   └── clipflow-tunnel.yml.example       ← Cloudflare tunnel config template
│
└── docs/
    ├── architecture.md              ← Deep dive on how the pipeline works
    ├── api-keys.md                  ← Where to get each API key
    ├── server-env-template.txt      ← .env template for the ClipFlow server
    └── troubleshooting.md           ← Common issues and fixes
```
