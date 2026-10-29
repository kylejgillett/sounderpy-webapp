# SounderPy Soundings

The web app for [SounderPy](https://github.com/kylejgillett/sounderpy): plot observed (RAOB),
aircraft (ACARS), model forecast (BUFKIT), and reanalysis (RAP-RUC) soundings in the browser.

Live at **https://sounderpy.app**. It replaces the old Anvil app (sounderpysoundings.anvil.app).

## How it fits together

- **The site (repo root):** a static [Astro](https://astro.build) site, deployed to GitHub
  Pages by `.github/workflows/deploy.yml` on every push to `main`. Changes only under `server/`
  don't redeploy it.
- **The API (`server/`):** a small FastAPI app on a DigitalOcean droplet at
  `https://api.sounderpy.app`. It fetches data and draws the plots with SounderPy. See
  [`server/README.md`](server/README.md).
- **Maps:** Leaflet, with a basemap drawn from public-domain Natural Earth data. No tile
  service or API key is needed.

## Develop locally

```bash
npm install
npm run dev          # http://localhost:4322
```

In dev mode the page calls a local API at `http://localhost:8000`. Start it in a second terminal:

```bash
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # first time only
.venv/bin/uvicorn api:app --port 8000 --reload
```

Set `PUBLIC_SOUNDERPY_API` to point the page at a different API.

## Layout

| Path | What it is |
|---|---|
| `src/pages/index.astro` | The app |
| `server/` | The API, its systemd unit and Caddyfile |
| `src/components/sounding/` | Tabs, request forms, figure settings, result frame |
| `src/scripts/sounding-app.js` | Page behaviour: requests, loading state, downloads, tabs |
| `src/scripts/station-map.js` | Leaflet maps, loaded on first use |
| `src/styles/global.css` | Site design, shared with kylegillettphoto.com |
| `public/data/` | Station lists and basemap layers, built by `npm run data` |

Re-run `npm run data` when SounderPy's station lists change, then commit `public/data/`.
