# 🎬 ClipFlow — TikTok Clip Machine

Automatically turn YouTube videos into viral TikTok clips. Paste a URL, and ClipFlow downloads the video, finds the best moments using AI, cuts them to vertical 9:16 format, dubs them into Spanish, and generates viral Spanish titles — all from a clean web UI.

---

## ✨ Features

- **🔗 YouTube → TikTok pipeline** — paste any YouTube URL and get ready-to-post clips
- **🤖 AI viral moment detection** — Claude Haiku analyzes the transcript and picks the top 3–5 most engaging moments (30–90s each)
- **✂️ Auto-clipping** — ffmpeg cuts and converts each moment to 9:16 vertical (1080×1920)
- **🗣️ Spanish dubbing** — HeyGen Dubbing API translates and dubs audio while preserving the speaker's voice style
- **📝 Viral title generator** — Claude Haiku generates 3 Spanish TikTok-optimized titles per clip
- **📡 Real-time progress** — Server-Sent Events (SSE) stream live job status to the UI
- **💾 Job persistence** — jobs survive server restarts (stored to `jobs.json`)
- **🎨 Dark UI** — professional job cards, queue preview, creator channel cards
- **💳 Stripe payments** — built-in payment flow (test mode ready)
- **📤 Buffer integration** — schedule clips to TikTok via Buffer API

---

## 🛠️ Tech Stack

| Layer | Tech |
|-------|------|
| Backend | Node.js + Express 5 |
| AI (moments + titles) | Anthropic Claude Haiku (`@anthropic-ai/sdk`) |
| Transcription | OpenAI Whisper API (`openai`) |
| Video download | yt-dlp (CLI) |
| Video processing | ffmpeg + fluent-ffmpeg |
| Spanish dubbing | HeyGen Dubbing API |
| Payments | Stripe |
| Scheduling | Buffer API |
| Frontend | Vanilla JS + HTML/CSS (dark theme) |

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) installed and in PATH
- [ffmpeg](https://ffmpeg.org/) installed and in PATH

### Install

```bash
git clone https://github.com/Gimel12/ClipFlow.git
cd ClipFlow
npm install
```

### Configure

Create a `.env` file in the root directory:

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...        # Claude Haiku for moments + titles
OPENAI_API_KEY=sk-...               # Whisper transcription

# Optional — for dubbing
HEYGEN_API_KEY=...                  # HeyGen Pro for Spanish dubbing

# Optional — for payments
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Optional — for Buffer scheduling
BUFFER_TOKEN=...

# Server
PORT=4000
```

### Run

```bash
npm start
```

Open [http://localhost:4000](http://localhost:4000) in your browser.

---

## 📂 Project Structure

```
ClipFlow/
├── server.js              # Express server, REST API, SSE, job management
├── agents.js              # Agent Mode backend (multi-step orchestration)
├── buffer.js              # Buffer API integration for TikTok scheduling
├── db.js                  # Simple JSON-based persistence layer
├── payments.js            # Stripe payment routes
├── pipeline/
│   ├── processor.js       # Main pipeline orchestrator
│   ├── downloader.js      # yt-dlp video download
│   ├── transcriber.js     # Whisper API transcription (VTT fallback)
│   ├── moment-finder.js   # Claude Haiku viral moment detection
│   ├── clipper.js         # ffmpeg 9:16 clip cutting
│   ├── dubber.js          # HeyGen Spanish dubbing
│   ├── title-generator.js # Claude Haiku viral title generation
│   ├── channel-fetcher.js # YouTube channel URL resolver
│   └── heygen-state.js    # HeyGen job state tracker
└── public/
    └── index.html         # Single-page dark UI
```

---

## 🔄 Pipeline Flow

```
YouTube URL
    │
    ▼
1. Download (yt-dlp) ──────────────── video + subtitles
    │
    ▼
2. Transcribe (Whisper API) ────────── full transcript with timestamps
    │
    ▼
3. Find Viral Moments (Claude Haiku) ── top 3–5 segments (30–90s)
    │
    ▼
4. Cut Clips (ffmpeg) ─────────────── 9:16 vertical MP4s
    │
    ▼
5. Dub to Spanish (HeyGen) ─────────── voice-preserved Spanish audio
    │
    ▼
6. Generate Titles (Claude Haiku) ───── 3 viral Spanish titles per clip
    │
    ▼
📦 Ready-to-post TikTok clips
```

---

## 📡 API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/jobs` | Submit a YouTube URL for processing |
| `GET` | `/api/jobs` | List all jobs |
| `GET` | `/api/jobs/:id` | Get job status + results |
| `DELETE` | `/api/jobs/:id` | Delete a job |
| `GET` | `/api/events` | SSE stream for real-time progress |
| `POST` | `/api/agents` | Trigger Agent Mode pipeline |
| `GET` | `/output/:file` | Serve generated clip files |

---

## ⚠️ Notes

- **Dubbing is optional** — if no HeyGen key is set, clips are delivered in the original language
- **Cookies** — some YouTube videos require authentication; export your browser cookies to `cookies.txt` using the included `export_cookies.command`
- **`.env` is gitignored** — never commit your API keys
- Output folders (`clips/`, `output/`, `dubbing/`) are gitignored — generated files stay local

---

## 📄 License

ISC
