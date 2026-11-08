# GroundTruthMaps
Creating automated, accessible maps of cities for cyclists and pedestrians.
<img width="870" height="780" alt="image" src="https://github.com/user-attachments/assets/5db13a57-3224-4149-a3ff-687146c40ee6" />

Architecture summary:
<img width="1266" height="1286" alt="image" src="https://github.com/user-attachments/assets/fc569f72-8612-4686-809a-50c0d78422f3" />

For Calgary, use https://jessikamessika.github.io/GroundTruthMaps/web/?city=calgary
(San Francisco: `?city=sf`).

## Layout

```
api/                      data pipeline and backend services
  scraping/               Python: fetch OSM + City/SFMTA closures, write GeoJSON
  workers/ors-proxy/      Cloudflare Worker: OpenRouteService proxy (routing)
  workers/construction-proxy/  Cloudflare Worker: City construction detours feed
  apps-script/signup.gs   Google Apps Script: sign-ups and delete requests
  doctor.py               preflight checks for the pipeline and its outputs
  patches/                old SF pipeline patches, kept for reference

app/                      web app: React + Vite + Tailwind CSS
  web/index.html          the map             -> /web/
  web/privacy.html        privacy notice      -> /web/privacy.html
  thesis/index.html       thesis summary      -> /thesis/
  src/core/               shared logic: config, routing, analytics, sign-up
  src/map/                map page (MapLibre controller, App, hooks)
  src/components/         map UI components
  public/data/            GeoJSON written by api/scraping (served as /data/)
  public/web/             icons, PWA manifests, vendored PostHog SDK
```

## Run the web app

Requires Node.js 20+. Run from the repo root (`package.json` lives there; the
scripts point Vite at `app/`).

```sh
npm install
npm run dev        # http://localhost:8000/web/ (port the Workers allow)
npm run build      # production build in app/dist/
npm run preview    # serve the build locally
```

## Refresh the data

```sh
pip install requests
python3 api/scraping/refresh_closures.py      # Calgary closures (every 3 h in CI)
python3 api/scraping/refresh_closures_sf.py   # SF closures (every 3 h in CI)
python3 api/scraping/merge.py                 # full rebuild incl. the OSM network
python3 api/doctor.py                         # preflight checks
```

## Deployment

- **Site:** `.github/workflows/deploy-pages.yaml` builds `app/` and publishes `app/dist` to
  GitHub Pages on every push to `main` that touches `app/`, and after each data refresh.
  Pages must be set to *Settings > Pages > Source: GitHub Actions*.
- **Workers:** each folder under `api/workers/` is its own Cloudflare Worker
  (`npx wrangler deploy` from that folder).
