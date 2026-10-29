# Going live: sounderpy.app

Do these in order. Steps 1–3 can happen any time; nothing breaks until step 6.

## 1. Buy the domain

Register `sounderpy.app` at any registrar. Cloudflare Registrar and Porkbun sell at cost,
roughly $15–20 a year. `.app` domains always require HTTPS, and GitHub Pages and Caddy both
handle that automatically.

## 2. Put this repo on GitHub

1. Create an **empty** repo at https://github.com/new named `sounderpy-webapp`, with no README
   or license, since this one has its own.
2. Push from this folder:
   ```bash
   git add -A
   git commit -m "Initial SounderPy web app"
   git remote add origin https://github.com/kylejgillett/sounderpy-webapp.git
   git push -u origin main
   ```
3. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
   The push triggers `.github/workflows/deploy.yml`, and the **Actions** tab shows the deploy.
   Until the domain is set, the site lives at `https://kylejgillett.github.io/sounderpy-webapp/`.
   That temporary address won't fully work, because the site is built for the domain root.
   That's expected.

## 3. Verify the domain with GitHub (recommended)

Your GitHub profile: **Settings → Pages → Add a domain → `sounderpy.app`**. GitHub shows a
`TXT` record to add at your DNS provider. Verifying stops anyone else from claiming the
domain on GitHub Pages.

## 4. DNS records

At your DNS provider (often the registrar), for `sounderpy.app`:

| Type | Name | Value | For |
|---|---|---|---|
| A | `@` | `185.199.108.153` | the site (GitHub Pages) |
| A | `@` | `185.199.109.153` | 〃 |
| A | `@` | `185.199.110.153` | 〃 |
| A | `@` | `185.199.111.153` | 〃 |
| AAAA | `@` | `2606:50c0:8000::153` | 〃 (IPv6, optional) |
| AAAA | `@` | `2606:50c0:8001::153` | 〃 |
| AAAA | `@` | `2606:50c0:8002::153` | 〃 |
| AAAA | `@` | `2606:50c0:8003::153` | 〃 |
| CNAME | `www` | `kylejgillett.github.io` | `www.sounderpy.app` → `sounderpy.app` |
| A | `api` | *your droplet's IP* | the API (Caddy on the droplet) |
| CNAME | `docs` | `kylejgillett.github.io` | the docs (step 7) |

**If you use Cloudflare for DNS,** set every one of these to **DNS only** (grey cloud), not
proxied. GitHub Pages and Caddy need direct traffic to issue their HTTPS certificates.

## 5. Connect the domain to this repo

Repo **Settings → Pages → Custom domain: `sounderpy.app` → Save**. After the DNS check
passes (minutes to a few hours), tick **Enforce HTTPS**.

## 6. Bring up the API on the droplet

Follow **Set up on the droplet** in [`server/README.md`](server/README.md). It clones only
the `server/` folder, reuses the uplink's known-good library versions, and sets up Caddy for
`api.sounderpy.app`. Check that it's up:

```bash
curl https://api.sounderpy.app/api/health
```

Then open https://sounderpy.app. The version line at the bottom of the page should say
`SounderPy v3.2.0` rather than "Sounding server is offline".

## 7. Docs at docs.sounderpy.app (optional, any time)

In the `sounderpy` repo: **Settings → Pages → Custom domain: `docs.sounderpy.app`**, then
**Enforce HTTPS**. GitHub redirects the old `kylejgillett.github.io/sounderpy/...` links.

If the docs are published by pushing built HTML to a branch (e.g. `gh-pages`), make sure
each build includes a file named `CNAME` containing `docs.sounderpy.app`. Otherwise the next
docs deploy can wipe the custom domain. With Sphinx, add it via `html_extra_path`.

Then update the Documentation link in `src/layouts/BaseLayout.astro`.

## 8. Move users off Anvil

1. Run both side by side for a few weeks, with a banner in the Anvil app linking to sounderpy.app.
2. Replace the Anvil app with a redirect page:
   `anvil.js.window.location.href = "https://sounderpy.app"`, plus a visible link as a fallback.
3. Check whether Anvil's free plan keeps the `sounderpysoundings.anvil.app` name before
   cancelling the paid plan.
4. Update links: SounderPy docs and README, the plot footer text in SounderPy (next release),
   Buy Me a Coffee, social profiles, and the "Open the web app" button on kylegillettphoto.com.
5. On the droplet, once Anvil is retired, follow **Retire the Anvil uplink** in
   [`server/README.md`](server/README.md), then archive the old `sounderpy-webapp-server` repo.
