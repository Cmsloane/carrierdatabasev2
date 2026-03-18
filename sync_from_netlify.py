#!/usr/bin/env python3
"""
sync_from_netlify.py — Circle Logistics CarrierDatabaseV2
==========================================================
Pulls the live production state from carrierdatabasev2.netlify.app
and updates the local seed file (backend/data/state.json).

Usage:
    python3 sync_from_netlify.py            # pull live → update state.json
    python3 sync_from_netlify.py --status   # show live vs local diff only

This is the single source of truth sync command. Run it any time
you want the local repo to reflect what's live on Netlify.

After running, commit + push to GitHub to re-deploy:
    git add backend/data/state.json
    git commit -m "sync: pull latest state from production"
    git push
"""

import json, os, sys, urllib.request, urllib.error
from datetime import datetime

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
STATE_PATH  = os.path.join(SCRIPT_DIR, 'backend', 'data', 'state.json')
LIVE_URL    = 'https://carrierdatabasev2.netlify.app/api/bootstrap'
HEALTH_URL  = 'https://carrierdatabasev2.netlify.app/api/health'

def fetch_json(url, timeout=30):
    req = urllib.request.Request(url)
    req.add_header('Accept', 'application/json')
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())

def load_local():
    if not os.path.exists(STATE_PATH):
        return {}
    with open(STATE_PATH) as f:
        return json.load(f)

def main():
    status_only = '--status' in sys.argv

    print('=' * 58)
    print('  CarrierDatabaseV2 — Netlify Sync')
    print(f'  {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
    print('=' * 58)

    # ── Health check ──────────────────────────────────────────
    print('\nChecking live site...')
    try:
        health = fetch_json(HEALTH_URL)
        print(f'  ✓ Backend  : {health.get("backend")}')
        print(f'  ✓ Store    : {health.get("store")}')
        print(f'  ✓ Revision : {health.get("revision")}')
    except Exception as e:
        print(f'  ✗ Health check failed: {e}')
        print('  Is your internet connected?')
        sys.exit(1)

    # ── Fetch live state ───────────────────────────────────────
    print('\nFetching live state...')
    try:
        live = fetch_json(LIVE_URL, timeout=60)
    except Exception as e:
        print(f'  ✗ Failed to fetch bootstrap: {e}')
        sys.exit(1)

    live_carriers = live.get('carriers', [])
    live_loads_data = live.get('loadsData', {})
    live_loads = live_loads_data.get('loads', [])
    live_meta = live.get('meta', {})
    live_revision = live_meta.get('revision', health.get('revision', '?'))

    print(f'  ✓ Carriers  : {len(live_carriers)}')
    print(f'  ✓ Loads     : {len(live_loads)}')
    print(f'  ✓ Revision  : {live_revision}')
    print(f'  ✓ Synced at : {live_loads_data.get("synced_at", "?")}')

    # ── Compare with local ────────────────────────────────────
    local = load_local()
    local_carriers = local.get('carriers', [])
    local_loads = local.get('loadsData', {}).get('loads', [])
    local_revision = local.get('revision', 0)

    print(f'\nLocal state:')
    print(f'  Carriers  : {len(local_carriers)}')
    print(f'  Loads     : {len(local_loads)}')
    print(f'  Revision  : {local_revision}')

    carrier_diff = len(live_carriers) - len(local_carriers)
    load_diff    = len(live_loads) - len(local_loads)

    print(f'\nDiff:')
    print(f'  Carriers  : {carrier_diff:+d}')
    print(f'  Loads     : {load_diff:+d}')
    print(f'  Revision  : {local_revision} → {live_revision}')

    if status_only:
        print('\n(--status mode: no changes written)')
        print('=' * 58)
        return

    if carrier_diff == 0 and load_diff == 0 and local_revision >= live_revision:
        print('\n✓ Already in sync — nothing to update')
        print('=' * 58)
        return

    # ── Write updated state.json ──────────────────────────────
    print('\nUpdating backend/data/state.json...')

    updated_state = {
        'carriers'   : live_carriers,
        'loadsData'  : live_loads_data,
        'revision'   : live_revision,
        'synced_at'  : datetime.now().isoformat(),
        'meta'       : {
            **live_meta,
            'carriersUpdatedAt' : live_meta.get('carriersUpdatedAt'),
            'lastSyncedBy'      : 'sync_from_netlify.py',
            'syncedAt'          : datetime.now().isoformat(),
            'source'            : LIVE_URL,
        }
    }

    # Back up existing state.json first
    if os.path.exists(STATE_PATH):
        backup = STATE_PATH.replace('.json', f'_backup_{datetime.now().strftime("%Y%m%d_%H%M%S")}.json')
        import shutil
        shutil.copy2(STATE_PATH, backup)
        print(f'  Backed up to: {os.path.basename(backup)}')

    with open(STATE_PATH, 'w', encoding='utf-8') as f:
        json.dump(updated_state, f, indent=2)

    print(f'  ✓ state.json updated')
    print(f'    {len(live_carriers)} carriers · {len(live_loads)} loads · revision {live_revision}')

    print(f'''
Next step — commit and push to trigger Netlify redeploy:

    git add backend/data/state.json carrier-database.html
    git commit -m "sync: pull production state (rev {live_revision}, {len(live_carriers)} carriers, {len(live_loads)} loads)"
    git push
''')
    print('=' * 58)


if __name__ == '__main__':
    main()
