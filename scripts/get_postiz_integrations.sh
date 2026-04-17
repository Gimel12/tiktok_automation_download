#!/bin/bash
# Look up your Postiz TikTok integration ID.
# You need this for POSTIZ_TIKTOK_ID in your .env files.
#
# Usage:
#   POSTIZ_API_KEY=your_key bash scripts/get_postiz_integrations.sh
# or:
#   bash scripts/get_postiz_integrations.sh your_key

KEY="${POSTIZ_API_KEY:-$1}"
if [ -z "$KEY" ]; then
  echo "Usage: POSTIZ_API_KEY=your_key bash scripts/get_postiz_integrations.sh"
  exit 1
fi

echo "Fetching Postiz integrations..."
curl -s "https://api.postiz.com/public/v1/integrations" \
  -H "Authorization: $KEY" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print('\nYour Postiz integrations:')
print('-' * 50)
for d in data:
    print(f\"  Platform: {d['identifier']}\")
    print(f\"  Name:     {d['name']}\")
    print(f\"  ID:       {d['id']}\")
    print()
"
