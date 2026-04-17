#!/usr/bin/env python3
"""
Deploy ClipFlow channel watchers on a new machine.

Creates one folder per YouTube channel with:
  - check_channel.js  (copied from watchers/)
  - package.json
  - .env              (filled with your credentials)
  - LaunchAgent plist (placed in ~/Library/LaunchAgents/)

Usage:
  python3 scripts/deploy_watchers.py \\
    --channels "@GrahamStephan" "@TheRamseyShowEpisodes" "@karltondennis" "@nischa" "@humphrey" \\
    --tg-token "123:AAA..." \\
    --tg-chat-id "544344605" \\
    --postiz-key "your_postiz_api_key" \\
    --postiz-tiktok-id "your_postiz_tiktok_integration_id" \\
    --output-dir ~/clipflow_watchers

Optional flags:
  --cookies-file /path/to/cookies.txt
  --clipflow-api http://localhost:4000
  --server-dir ~/Downloads/TikTok\\ Clip\\ Machine  (generates server LaunchAgent too)
  --openai-key sk-proj-...
"""

import argparse
import shutil
import subprocess
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent.parent

# Staggered daily schedule (UTC) — adjust for DST as needed
# Format: (hour_utc, minute)
SCHEDULE = [
    (14, 0),   # 9:00 AM ET / 10:00 AM EST
    (14, 30),  # 9:30 AM ET
    (15, 0),   # 10:00 AM ET
    (15, 30),  # 10:30 AM ET
    (16, 0),   # 11:00 AM ET
    (17, 0),   # 12:00 PM ET
    (18, 0),   # 1:00 PM ET
]

PLIST_TEMPLATE = """\
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{node_path}</string>
        <string>{watcher_js}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{watcher_dir}</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>{hour}</integer>
        <key>Minute</key>
        <integer>{minute}</integer>
    </dict>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/{slug}.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/{slug}.log</string>
</dict>
</plist>
"""

SERVER_PLIST_TEMPLATE = """\
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ruben.clipflow-server</string>
    <key>ProgramArguments</key>
    <array>
        <string>{node_path}</string>
        <string>{server_js}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{server_dir}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>OPENAI_API_KEY</key>
        <string>{openai_key}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/clipflow_server.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/clipflow_server.log</string>
</dict>
</plist>
"""


def channel_to_slug(channel: str) -> str:
    """@GrahamStephan → graham_stephan"""
    name = channel.lstrip('@')
    slug = ''
    for i, c in enumerate(name):
        if c.isupper() and i > 0:
            slug += '_'
        slug += c.lower()
    return slug.replace('-', '_')


def find_node() -> str:
    for candidate in ['/opt/homebrew/bin/node', '/usr/local/bin/node']:
        if Path(candidate).exists():
            return candidate
    result = subprocess.run(['which', 'node'], capture_output=True, text=True)
    return result.stdout.strip() or 'node'


def main():
    parser = argparse.ArgumentParser(description='Deploy ClipFlow watchers')
    parser.add_argument('--channels', nargs='+', required=True,
                        help='YouTube channel handles e.g. @GrahamStephan')
    parser.add_argument('--tg-token',           required=True, help='Telegram bot token')
    parser.add_argument('--tg-chat-id',         required=True, help='Telegram chat ID')
    parser.add_argument('--postiz-key',         required=True, help='Postiz API key')
    parser.add_argument('--postiz-tiktok-id',   required=True, help='Postiz TikTok integration ID')
    parser.add_argument('--clipflow-api',        default='http://localhost:4000')
    parser.add_argument('--cookies-file',        default='')
    parser.add_argument('--output-dir',          default='~/clipflow_watchers')
    parser.add_argument('--server-dir',          default='',
                        help='Path to ClipFlow server folder (generates server LaunchAgent)')
    parser.add_argument('--openai-key',          default='',
                        help='OpenAI API key (for server LaunchAgent)')
    parser.add_argument('--label-prefix',        default='com.ruben.clipflow-watcher')
    args = parser.parse_args()

    output_dir      = Path(args.output_dir).expanduser()
    launchagents_dir = Path('~/Library/LaunchAgents').expanduser()
    watcher_js_src  = REPO_DIR / 'watchers' / 'check_channel.js'
    package_json_src = REPO_DIR / 'watchers' / 'package.json'
    node_path       = find_node()

    output_dir.mkdir(parents=True, exist_ok=True)
    print(f'\nDeploying {len(args.channels)} watcher(s) to {output_dir}\n')

    for i, channel in enumerate(args.channels):
        slug         = channel_to_slug(channel)
        label        = f'{args.label_prefix}-{slug.replace("_", "-")}'
        watcher_dir  = output_dir / f'clipflow_watcher_{slug}'
        watcher_dir.mkdir(parents=True, exist_ok=True)

        dest_js = watcher_dir / 'check_channel.js'
        shutil.copy2(watcher_js_src, dest_js)
        shutil.copy2(package_json_src, watcher_dir / 'package.json')

        env_content = (
            f'CHANNEL_URL=https://www.youtube.com/{channel}/shorts\n'
            f'CLIPFLOW_API={args.clipflow_api}\n'
            f'TG_TOKEN={args.tg_token}\n'
            f'TG_CHAT_ID={args.tg_chat_id}\n'
            f'COOKIES_FILE={args.cookies_file}\n'
            f'POSTIZ_API_KEY={args.postiz_key}\n'
            f'POSTIZ_TIKTOK_ID={args.postiz_tiktok_id}\n'
        )
        (watcher_dir / '.env').write_text(env_content)

        hour, minute = SCHEDULE[i % len(SCHEDULE)]
        plist_content = PLIST_TEMPLATE.format(
            label=label,
            node_path=node_path,
            watcher_js=str(dest_js),
            watcher_dir=str(watcher_dir),
            hour=hour,
            minute=minute,
            slug=f'clipflow_watcher_{slug}',
        )
        plist_file = launchagents_dir / f'{label}.plist'
        plist_file.write_text(plist_content)

        print(f'  ✅ {channel}')
        print(f'     Folder:      {watcher_dir}')
        print(f'     Schedule:    {hour:02d}:{minute:02d} UTC daily')
        print(f'     LaunchAgent: {plist_file}')
        print()

    if args.server_dir:
        server_dir = Path(args.server_dir).expanduser()
        server_plist = SERVER_PLIST_TEMPLATE.format(
            node_path=node_path,
            server_js=str(server_dir / 'server.js'),
            server_dir=str(server_dir),
            openai_key=args.openai_key,
        )
        server_plist_file = launchagents_dir / 'com.ruben.clipflow-server.plist'
        server_plist_file.write_text(server_plist)
        print(f'  ✅ Server LaunchAgent: {server_plist_file}\n')

    print('Next steps:')
    print('  1. cd into each watcher folder and run: npm install')
    print('  2. Load watchers: launchctl load ~/Library/LaunchAgents/com.ruben.clipflow-watcher-*.plist')
    if args.server_dir:
        print('  3. Load server:   launchctl load ~/Library/LaunchAgents/com.ruben.clipflow-server.plist')
    print('  4. Verify:        launchctl list | grep clipflow')


if __name__ == '__main__':
    main()
