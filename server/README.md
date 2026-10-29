# SounderPy Soundings API

The FastAPI app behind [sounderpy.app](https://sounderpy.app). It runs on a DigitalOcean
droplet at `https://api.sounderpy.app`, fetches sounding data, and draws plots with SounderPy.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{online, sounderpy_version}` |
| GET | `/api/bufkit/latest-runs` | latest run per BUFKIT model (cached 5 min) |
| GET | `/api/acars/profiles?date=YYYY-MM-DD&hour=HH` | ACARS profiles for one hour, all airports |
| GET | `/api/acars/profiles?date=YYYY-MM-DD&airport=DEN` | ACARS profiles for one airport, all day |
| POST | `/api/sounding` | `{label, info, image}` for `output: "png"`, or a CSV/CM1/SHARPpy file |

Interactive docs are at `/docs` while it runs. Allowed browser origins default to
`https://sounderpy.app`, `https://kylegillettphoto.com`, and the local dev ports. Override them
with `ALLOWED_ORIGINS` (comma-separated).

## Run locally

```bash
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn api:app --port 8000 --reload
```

Then `npm run dev` at the repo root. In dev mode the page calls `http://localhost:8000`.

## Set up on the droplet

These steps run as root. They assume the old Anvil uplink lives in
`/root/sounderpy-sounding-server` and keeps running until the switch-over.

**0. Check free space.** The repo is about 3 MB, but a Python environment with SounderPy is
roughly 0.5–1 GB.

```bash
df -h /
du -sh /root/sounderpy-sounding-server/venv
```

**1. Clone only the `server/` folder.** A sparse clone skips the website files.

```bash
cd /root
git clone --filter=blob:none --no-checkout https://github.com/kylejgillett/sounderpy-webapp.git
cd sounderpy-webapp
git sparse-checkout set server
git checkout main
```

**2. Create the Python environment with the same library versions as the working uplink.**
`requirements.txt` only pins SounderPy, so a fresh install pulls the newest numpy, pandas,
MetPy and Pint. Newer versions can break some plots (e.g. ACARS). Copying the droplet's
known-good versions avoids that.

```bash
python3 -m venv server/venv
/root/sounderpy-sounding-server/venv/bin/pip freeze | grep -iv '^anvil' > /tmp/pinned.txt
server/venv/bin/pip install --no-cache-dir -r /tmp/pinned.txt fastapi "uvicorn[standard]"
server/venv/bin/pip freeze > server/requirements.lock   # keep a record of what's running
```

*Short on space for two environments?* Point the service at the uplink's venv instead. Run
`/root/sounderpy-sounding-server/venv/bin/pip install fastapi "uvicorn[standard]"`, then
change `ExecStart` in `sounderpy_api.service` to use that venv's `uvicorn`. Build
`server/venv` after the Anvil uplink is retired.

**3. Start the API.**

```bash
cp server/sounderpy_api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sounderpy_api
curl localhost:8000/api/health
```

**4. HTTPS with Caddy.** First point an `A` record for `api.sounderpy.app` at the droplet.

```bash
apt install caddy        # if not found: https://caddyserver.com/docs/install#debian-ubuntu-raspbian
cp server/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
ufw allow 80,443/tcp     # only if ufw is enabled
curl https://api.sounderpy.app/api/health
```

Logs: `journalctl -u sounderpy_api -f`

**5. Downtime alerts with Healthchecks.io.** Every 5 minutes a timer checks the public health
URL, which covers the API, Caddy, the certificate, and DNS. Each check reports to Healthchecks.io,
which emails you when checks fail or stop arriving.

1. In Healthchecks.io, add a check named `sounderpy-api` with **Period 5 minutes** and
   **Grace 10 minutes**, and copy its ping URL (`https://hc-ping.com/…`).
2. Save the ping URL on the droplet. It stays out of the repo, and anyone with it can mark the check up or down.
   ```bash
   echo 'HC_PING_URL=https://hc-ping.com/your-uuid' > /etc/sounderpy-healthcheck.env
   chmod 600 /etc/sounderpy-healthcheck.env
   ```
3. Install and start the timer, then run it once by hand:
   ```bash
   cp server/sounderpy_healthcheck.service server/sounderpy_healthcheck.timer /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now sounderpy_healthcheck.timer
   systemctl start sounderpy_healthcheck.service && journalctl -u sounderpy_healthcheck -n 5
   ```
   Healthchecks.io should now show the check as up. `systemctl list-timers sounderpy_healthcheck`
   shows when the next check runs.

## Update after a change

```bash
cd /root/sounderpy-webapp && git pull && systemctl restart sounderpy_api
```

## Retire the Anvil uplink

Once sounderpy.app is live and the Anvil app redirects to it:

```bash
systemctl disable --now anvil_uplink
rm /etc/systemd/system/anvil_uplink.service && systemctl daemon-reload
rm -rf /root/sounderpy-sounding-server      # frees the old venv's space
rm -f /etc/sounderpy-sounding-server.env    # held the Anvil uplink key
```

Then archive the `sounderpy-webapp-server` repo on GitHub (Settings → Archive).
