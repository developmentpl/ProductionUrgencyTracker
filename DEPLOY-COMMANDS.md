# Production Urgency Tracker — VPS Deployment Commands

First-time deploy of this app as a sub-app of the Operations Portal, mounted at **`/urgency/`**.
Run everything below in the **Hostinger web terminal** (hpanel.hostinger.com → VPS `srv1479112` → Browser SSH), in order.

Fixed values for this app:

| Item | Value |
|---|---|
| Repo | `https://github.com/developmentpl/ProductionUrgencyTracker.git` |
| Folder on VPS | `/var/www/ProductionUrgencyTracker` |
| Mount path | `/urgency/` |
| Router var | `urgencyRouter` |
| Database | `production_urgency_tracker` |

---

## Step 0 — Get the Postgres password

```bash
cat /var/www/5s-tracker/.env
```

Copy the `fivesuser:<password>` part of `DATABASE_URL`. You'll paste the password into Step 3.

## Step 1 — Sanity-check the VPS is healthy first

```bash
ls /var/www && echo "---" && pm2 list && echo "---" && which node
```

Expect `5s-tracker` present and `online`, no app `errored`. `ProductionUrgencyTracker` should NOT exist yet. If anything is broken, stop and fix that first.

## Step 2 — Create the database

```bash
sudo -u postgres psql -c "CREATE DATABASE production_urgency_tracker OWNER fivesuser;"
sudo -u postgres psql -l | grep production_urgency_tracker
```

## Step 3 — Clone, create .env, install, init DB

```bash
cd /var/www && git clone https://github.com/developmentpl/ProductionUrgencyTracker.git
cd /var/www/ProductionUrgencyTracker
cat > .env << 'EOF'
DATABASE_URL=postgres://fivesuser:PUT_PASSWORD_HERE@localhost:5432/production_urgency_tracker
EOF
# edit the line above so PUT_PASSWORD_HERE is the real password, then:
cat .env
npm install --omit=dev && npm run init-db
```

Expect `Applying schema...`, `Seeding 10 orders.` (or `Skipping seed`), `Done.`
If you see `password authentication failed` → wrong password in `.env`.

## Step 4 — Mount the router in the main server.js (back up first!)

```bash
cp /var/www/5s-tracker/server.js /var/www/5s-tracker/server.js.bak.$(date +%Y%m%d-%H%M%S)
ls -la /var/www/5s-tracker/server.js*
```

```bash
APP_FOLDER="ProductionUrgencyTracker"
MOUNT_PATH="/urgency"
ROUTER_VAR="urgencyRouter"

python3 << PYEOF
import re
fn = '/var/www/5s-tracker/server.js'
folder, mount, router_v = "${APP_FOLDER}", "${MOUNT_PATH}", "${ROUTER_VAR}"
with open(fn) as f: text = f.read()
if folder in text:
    print(f'Mount for {folder} already present, skipping')
else:
    pattern = r"(app\.use\('\/production',\s*productionRouter\);\s*\n)"
    new_block = (f"\nconst {router_v} = require('/var/www/{folder}/server');\n"
                 f"app.use('{mount}', {router_v});\n")
    new_text, n = re.subn(pattern, r"\1" + new_block, text, count=1)
    if n != 1:
        pattern = r"(app\.listen\()"
        new_text, n = re.subn(pattern, new_block + "\n" + r"\1", text, count=1)
    if n != 1: raise SystemExit('Could not find an insertion point in server.js')
    with open(fn, 'w') as f: f.write(new_text)
    print(f'Mounted {folder} at {mount}')
with open(fn) as f: lines = f.readlines()
for i, l in enumerate(lines):
    if folder in l:
        for j in range(max(0,i-3), min(len(lines),i+3)): print(f'{j+1:>4}: {lines[j].rstrip()}')
        break
PYEOF
```

### Syntax check — DO NOT restart if this fails

```bash
node --check /var/www/5s-tracker/server.js && echo "OK"
```

If it prints a `SyntaxError`, restore: `cp /var/www/5s-tracker/server.js.bak.<newest> /var/www/5s-tracker/server.js`

## Step 5 — Add the portal card

```bash
APP_NAME="Production Urgency Tracker"
APP_DESC="Live urgent work-order dashboard for the shop-floor TV."
MOUNT_PATH="/urgency/"
EMOJI="🚨"
ICON_BG="#fef2f2"

python3 << PYEOF
import re
fn = '/var/www/5s-tracker/portal/index.html'
name, desc, url_path, emoji, icon_bg = "${APP_NAME}", "${APP_DESC}", "${MOUNT_PATH}", "${EMOJI}", "${ICON_BG}"
with open(fn) as f: text = f.read()
if f"url: '{url_path}'" in text:
    print(f'Card for {url_path} already present, skipping')
else:
    m = re.search(r'(?P<brace>[ \t]+)\{\s*\n(?P<prop>[ \t]+)name:', text)
    if not m: raise SystemExit('Could not detect card indentation')
    bi, pi = m.group('brace'), m.group('prop')
    new_card = (f"{bi}{{\n{pi}name: '{name}',\n{pi}icon: '{emoji}',\n"
                f"{pi}iconBg: '{icon_bg}',\n{pi}description: '{desc}',\n"
                f"{pi}url: '{url_path}',\n{pi}status: 'live'\n{bi}}},\n")
    new_text, n = re.subn(r'([ \t]*//\s*To add a new app)', new_card + r'\1', text, count=1)
    if n != 1:
        new_text, n = re.subn(r'(\n\s*\];)', '\n' + new_card.rstrip('\n') + r'\1', text, count=1)
    if n != 1: raise SystemExit('Could not find an insertion point in portal/index.html')
    with open(fn, 'w') as f: f.write(new_text)
    print(f'Inserted card for {name}')
PYEOF
```

## Step 6 — Restart PM2 and check logs

```bash
pm2 restart 5s-tracker && sleep 2 && pm2 list && echo "---" && pm2 logs 5s-tracker --lines 30 --nostream
```

Look for `5s-tracker` `online` with fresh uptime, no `SyntaxError`, no `Cannot find module`, no `relation "X" does not exist`.

## Step 7 — Browser smoke test

1. `https://operation.yotser.in/` — new 🚨 card appears.
2. Click it → `https://operation.yotser.in/urgency/` loads with full styling.
3. `https://operation.yotser.in/urgency/api/health` → `{"ok":true}`
4. `https://operation.yotser.in/urgency/admin` → admin panel loads; add a test order, confirm it appears on the dashboard, then delete it.

---

## Rollback (if anything breaks)

```bash
# main server.js broke the portal:
cp /var/www/5s-tracker/server.js.bak.<newest> /var/www/5s-tracker/server.js && pm2 restart 5s-tracker

# the app itself is bad:
cd /var/www/ProductionUrgencyTracker && git reset --hard HEAD@{1} && pm2 restart 5s-tracker
```

## Future updates (after this first deploy)

```bash
cd /var/www/ProductionUrgencyTracker && git pull && pm2 restart 5s-tracker
```
