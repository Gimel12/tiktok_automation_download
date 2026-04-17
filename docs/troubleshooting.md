# Troubleshooting

## Common Issues

### Watcher: `fetch failed` or `ECONNREFUSED`
**Cause:** ClipFlow server is not running.
```bash
# Check if it's running
curl http://localhost:4000

# Check the server log
tail -50 /tmp/clipflow_server.log

# Restart the LaunchAgent
launchctl stop com.ruben.clipflow-server
launchctl start com.ruben.clipflow-server
```

### Watcher: `No videos found — channel fetch failed`
**Cause:** yt-dlp failed to fetch the YouTube channel.
```bash
# Test manually
yt-dlp --flat-playlist --playlist-end 5 -J "https://www.youtube.com/@GrahamStephan/shorts"

# Update yt-dlp (YouTube changes its API often)
brew upgrade yt-dlp

# If age-restricted: make sure cookies.txt is set and valid
```

### Server: `401 OpenAI` error
**Cause:** The OpenAI key in the LaunchAgent env is stale.
```bash
# Update it live without reloading the plist
launchctl setenv OPENAI_API_KEY sk-proj-new-key-here

# Then restart the server
launchctl stop com.ruben.clipflow-server
launchctl start com.ruben.clipflow-server
```

### Server: Multiple server processes running
**Cause:** Crashed and restarted multiple times without cleanup.
```bash
pkill -f "TikTok Clip Machine/server.js"
# LaunchAgent will restart it automatically in a few seconds
```

### HeyGen job stuck / never completes
**Cause:** The tunnel was down when HeyGen tried to deliver the dubbed file.
```bash
# Clear the stuck jobs file
echo '{}' > ~/Downloads/"TikTok Clip Machine"/heygen_jobs.json

# Restart the server
launchctl stop com.ruben.clipflow-server
launchctl start com.ruben.clipflow-server

# Verify tunnel is running
tail -20 /tmp/clipflow-tunnel.log
curl https://clips.yourdomain.com
```

### Cloudflare tunnel won't start
```bash
# Run manually to see the error
cloudflared tunnel run clipflow

# Check config file
cat ~/.cloudflared/clipflow-tunnel.yml

# Re-authenticate if credentials expired
cloudflared tunnel login
```

### Postiz upload fails: `401` or `Unauthorized`
**Cause:** Postiz API key is wrong or expired.
```bash
# Verify the key works
POSTIZ_API_KEY=your_key bash scripts/get_postiz_integrations.sh
```

### LaunchAgent not firing on schedule
```bash
# Check if it's loaded (PID column should not be -)
launchctl list | grep clipflow

# Reload if needed
launchctl unload ~/Library/LaunchAgents/com.ruben.clipflow-watcher-graham-stephan.plist
launchctl load ~/Library/LaunchAgents/com.ruben.clipflow-watcher-graham-stephan.plist
```

### Watcher processes the same video twice
**Cause:** `state.json` was deleted or corrupted.
```bash
# Check the state file
cat ~/clipflow_watchers/clipflow_watcher_graham_stephan/state.json

# Pre-populate with recent video IDs to prevent reprocessing
# Get video IDs:
yt-dlp --flat-playlist --playlist-end 10 -J "https://www.youtube.com/@GrahamStephan/shorts" \
  | python3 -c "import json,sys; [print(e['id']) for e in json.load(sys.stdin)['entries']]"
```

---

## Viewing All Logs

```bash
# Live tail all watcher logs at once
tail -f /tmp/clipflow_watcher_*.log

# Server log
tail -f /tmp/clipflow_server.log

# Tunnel log
tail -f /tmp/clipflow-tunnel.log
```

---

## Quick Health Check

```bash
echo "=== Server ===" && curl -s http://localhost:4000 | head -c 100
echo ""
echo "=== Tunnel ===" && curl -s -o /dev/null -w "%{http_code}" https://clips.yourdomain.com
echo ""
echo "=== LaunchAgents ===" && launchctl list | grep clipflow
```
