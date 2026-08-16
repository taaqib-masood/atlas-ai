# Runbook — Atlas AI Directory

Production operations guide: deployment, configuration, backup, restore, monitoring, rollback, and troubleshooting. Applies to the zero-dependency Node app in this repository.

## 1. Architecture in one paragraph

A single Node.js process serves server-rendered HTML + a small JSON API. State lives in one SQLite file (`data/app.db`, WAL mode) — or a JSON file (`data/app.json`) on runtimes without `node:sqlite`. No build step, no external services, no npm install. Scale-out is vertical (one instance) or via a load balancer with a shared DB volume; sessions and rate limits are in-memory, so **run one instance** (or sticky sessions + a shared data dir).

## 2. Deploy to a VPS (recommended)

```bash
# On the server (Ubuntu/Debian example)
sudo apt update && sudo apt install -y nodejs   # Node >= 22.5 (use NodeSource for 22.x)
scp -r . user@host:/srv/atlas-ai
cd /srv/atlas-ai && rm -rf backups data        # fresh install
```

Create `/etc/systemd/system/atlas-ai.service` (example included in `deploy/`):

```ini
[Unit]
Description=Atlas AI directory
After=network.target

[Service]
WorkingDirectory=/srv/atlas-ai
Environment=PORT=3000
Environment=DATA_DIR=/srv/atlas-ai/data
Environment=BASE_URL=https://tools.example.com
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now atlas-ai
curl -s localhost:3000/healthz   # {"ok":true,"storage":"sqlite","published":91,...}
```

Reverse proxy (nginx):

```nginx
server {
  listen 443 ssl; server_name tools.example.com;
  # ... TLS certs ...
  location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }
}
```

**First-boot checklist:** (1) confirm `/healthz` shows `storage: sqlite`; (2) log in as `admin@example.com` / printed password and **change it**; (3) set `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars on future installs to avoid the default admin; (4) verify `/sitemap.xml` resolves from the public domain.

## 3. Function Compute (Aliyun FC 3.0, nodejs20) deployment

The repo ships `index.js` (FC handler adapter) at the root — the FC `nodejs20` built-in runtime expects exactly this layout.

```bash
bash scripts/package-fc.sh      # produces dist/atlas-fc.zip with index.js at the zip root
```

FC notes (see `lib/core.js` for the shared pipeline):
- **Storage:** FC nodejs20 has no `node:sqlite` → set `STORAGE=json` and `DATA_DIR=/tmp/atlas` (only `/tmp` is writable). Data is ephemeral per instance unless you mount a NAS or sync `app.json` to object storage — for anything beyond a demo, run the VPS/PaaS path instead.
- `BASE_URL` must be the public URL for canonical tags/sitemap.
- Each request must finish within FC's timeout (60 s default) — the app is well under this.

## 4. Backup (hot, no downtime)

```bash
bash scripts/backup.sh          # WAL-checkpoint then copy → backups/app-<ts>.db
```

The script works with SQLite (uses the `sqlite3` CLI when present, else a Node checkpoint) and also copies `app.json` when in JSON mode. **Backups are only as good as their off-box copy** — ship `backups/` to object storage or a second host (e.g. `rclone sync backups/ b2:atlas-backups/`). Suggested cadence: daily backup + weekly off-site copy; retain 30 days.

## 5. Restore

```bash
bash scripts/restore.sh backups/app-20260811-020000.db
```

The script stops the running server, replaces the database (removing stale WAL/SHM files), and prints how to restart. For JSON mode, restore `app.json` the same way.

## 6. Rollback (code + data)

```bash
bash scripts/rollback.sh v1.2.0 backups/app-20260811-020000.db
# or: git checkout v1.2.0 && node server.js   (code-only rollback)
```

Procedure: (1) restore the last-good database backup (step 5); (2) checkout the previous release (`git tag` releases — see `git tag -l`); (3) restart; (4) verify `/healthz` + a representative page. If the failure was caused by a bad deploy rather than bad data, the code checkout alone is sufficient.

## 7. Monitoring

- **Health:** poll `/healthz` every 30–60 s; alert on non-200 or `"ok":false`.
- **Key numbers to watch:** published-tool count (should be stable unless you're editing), error rate in `journalctl -u atlas-ai`, disk usage of `data/` + `backups/` (SQLite grows slowly; backups grow daily), response time of `/` (budget < 250 ms local, < 1 s behind a proxy).
- **Logs:** `journalctl -u atlas-ai -f`. The app logs startup info and 500-level request errors with stack traces.
- **Capacity:** one VPS instance handles this workload comfortably; when the DB exceeds ~1–2 GB or the instance saturates, move the data dir to a managed disk/DB and scale out behind a load balancer (keep sessions sticky or move sessions to a shared store).

## 8. Security hardening checklist

- [ ] Change/remove the default admin password; set `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars.
- [ ] Terminate TLS at the proxy; the app sets `SameSite=Lax` + `HttpOnly` cookies and security headers (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`) automatically. Add `Secure` on the cookie by terminating TLS and using `BASE_URL=https://…` — the app sets `Secure` only when the request arrives over HTTPS.
- [ ] Keep Node updated (security patches); the app has zero third-party dependencies, so there is no npm supply-chain surface.
- [ ] Back up `data/` before any schema-affecting upgrade; `STORAGE=auto` prefers SQLite — don't switch formats without a backup.
- [ ] Rate limits (login 10/15 min per IP+email, register 5/h per IP) are in-memory per instance — behind a proxy, ensure `X-Forwarded-For` is trusted only from your proxy.

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `GET /browse` → 500 | Check logs; usually a code issue after upgrade — roll back (step 6). |
| Health shows `published: 0` | Seeding failed on boot (log shows `Seed warning`). Ensure `DATA_DIR` is writable, then restart; seeding is idempotent. |
| Logins rejected everywhere | You hit the in-memory rate limit (10 attempts/15 min/IP). Wait, or restart the process to clear counters. |
| `node:sqlite` errors | Node < 22.5 — upgrade Node, or set `STORAGE=json` (feature-identical fallback). |
| Favorites lost after deploy | `DATA_DIR` changed between environments — keep it stable or restore the backup (step 5). |
| FC: writes disappear | FC instances are ephemeral; `DATA_DIR` must be `/tmp` + persisted externally, or use the VPS path. |

## 10. Release procedure (repeatable)

1. `git tag vX.Y.Z` before deploy; push tag.
2. `bash scripts/backup.sh` (pre-deploy safety net).
3. Deploy code; `systemctl restart atlas-ai`.
4. Verify `/healthz`, one category page, one tool page, login + favorite round-trip.
5. On failure within the window: `bash scripts/rollback.sh <prev-tag> <pre-deploy-backup>`.
