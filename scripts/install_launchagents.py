#!/usr/bin/env python3
"""
Load (or unload) all ClipFlow LaunchAgents into macOS launchctl.
Run this after deploy_watchers.py.

Usage:
  python3 scripts/install_launchagents.py          # load all
  python3 scripts/install_launchagents.py --unload  # remove all
"""

import argparse
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--unload', action='store_true', help='Unload instead of load')
    args = parser.parse_args()

    la_dir = Path('~/Library/LaunchAgents').expanduser()
    plists = sorted(la_dir.glob('com.ruben.clipflow*.plist'))

    if not plists:
        print('No clipflow LaunchAgent plists found in ~/Library/LaunchAgents/')
        print('Run deploy_watchers.py first.')
        return

    action = 'unload' if args.unload else 'load'
    print(f'\n{action.capitalize()}ing {len(plists)} LaunchAgent(s)...\n')

    for plist in plists:
        result = subprocess.run(
            ['launchctl', action, str(plist)],
            capture_output=True, text=True
        )
        status = '✅' if result.returncode == 0 else '❌'
        print(f'  {status} {plist.name}')
        if result.stderr:
            print(f'     {result.stderr.strip()}')

    print(f'\nVerify: launchctl list | grep clipflow')


if __name__ == '__main__':
    main()
