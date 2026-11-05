// Builds the data used by the sounding-analysis maps: station and airport lists
// from SounderPy's station files, plus public-domain Natural Earth layers for the
// basemap. Re-run when those lists change:
//
//   node scripts/build-station-data.mjs
//   node scripts/build-station-data.mjs bufkit-stations.json   (just the files named)
//
// Station rows are compact arrays: [id, name, region, lat, lon, elevation_m]. BUFKIT rows add a
// seventh entry: the models with files for that station, as letters (see BUFKIT_MODEL_CODES).

import { mkdir, writeFile } from "node:fs/promises";

const SRC = "https://raw.githubusercontent.com/kylejgillett/sounderpy/main/src";
const NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson";
const OUT = new URL("../public/data/", import.meta.url);
const BORDERS = {
  "world-50m.json": "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json",
  "us-states-10m.json": "https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-10m.json",
};

const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const round = (n) => Math.round(n * 100) / 100;

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}
const fetchLines = async (file) => (await fetchText(`${SRC}/${file}`)).split(/\r?\n/);
const fetchJson = async (url) => JSON.parse(await fetchText(url));

// WMO,ICAO,NAME,LOC,EL(m),LAT,A,LON,B
async function raobStations() {
  const rows = [];
  for (const line of await fetchLines("RAOB-STATIONS.txt")) {
    const f = line.split(",").map((v) => v.trim());
    if (f.length < 9 || !/^\d+$/.test(f[0])) continue;
    const lat = Number(f[5]) * (f[6] === "S" ? -1 : 1);
    const lon = Number(f[7]) * (f[8] === "W" ? -1 : 1);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const id = /^-+$/.test(f[1]) || !f[1] ? f[0] : f[1];
    rows.push([id, titleCase(f[2]), f[3], round(lat), round(lon), Number(f[4]) || 0]);
  }
  return rows;
}

// Old IDs in SounderPy's list for stations listed again under their current ID (same NCEP number),
// plus XLIK, which has no data at all. server/api.py redirects the old IDs.
const RETIRED_BUFKIT = new Set(["K2IS", "KBNY", "K36U", "KWIN", "KBNG", "KY26", "ISQ", "KFST", "OSC", "XLIK"]);

// ,NUM,LAT,LON,ID,NAME,LOC,EL(m),NOTE — stations repeat once per model section.
async function bufkitStations() {
  const seen = new Map();
  for (const line of await fetchLines("BUFKIT-STATIONS-MASTER.txt")) {
    const f = line.split(",").map((v) => v.trim());
    if (f.length < 8 || !/^\d+$/.test(f[0]) || !f[4]) continue;
    const lat = Number(f[2]), lon = Number(f[3]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || seen.has(f[4]) || RETIRED_BUFKIT.has(f[4])) continue;
    seen.set(f[4], [f[4], titleCase(f[5]), f[6], round(lat), round(lon), Number(f[7]) || 0]);
  }
  const rows = [...seen.values()];
  const models = await bufkitModels(rows.map(([id]) => id));
  for (const row of rows) row.push(models.get(row[0]) ?? "");
  return rows;
}

// One letter per model, in the order the form lists them. The site reads this too (station-map.js).
const BUFKIT_MODEL_CODES = { hrrr: "h", rrfs: "r", rap: "a", gfs: "g", nam: "n", namnest: "m" };
const IEM_ARCHIVE = "https://mtarchive.geol.iastate.edu";
const NAM_LAST_ARCHIVE = "2026/11/03/bufkit/00"; // the RRFS replaced the NAM after this run

// Which models have a file for each station: a snapshot, read when this script runs. IEM's archive
// lists its files, so one run per model covers every station.
async function bufkitModels(ids) {
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10).replaceAll("-", "/");
  const archived = { // [IEM folder, file prefix]
    hrrr: [`${day}/bufkit/12/hrrr`, "hrrr"], rrfs: [`${day}/bufkit/12/rrfs`, "rrfs"],
    rap: [`${day}/bufkit/12/rap`, "rap"], gfs: [`${day}/bufkit/12/gfs`, "gfs3"],
    nam: [`${NAM_LAST_ARCHIVE}/nam`, "nam"], namnest: [`${NAM_LAST_ARCHIVE}/nam4km`, "nam4km"],
  };
  const has = new Map(ids.map((id) => [id, new Set()]));
  for (const [model, [folder, prefix]] of Object.entries(archived)) {
    const html = await fetchText(`${IEM_ARCHIVE}/${folder}/`);
    const files = new Set([...html.matchAll(new RegExp(`${prefix}_([^"<>/]+?)\\.buf`, "g"))].map((m) => decodeURIComponent(m[1]).toUpperCase()));
    if (!files.size) throw new Error(`No ${model} files listed at IEM for ${folder}`);
    for (const id of ids) if (files.has(id.toUpperCase())) has.get(id).add(model);
    console.log(`  ${model}: ${files.size} files at IEM`);
  }
  return new Map(ids.map((id) => [id, Object.keys(BUFKIT_MODEL_CODES).filter((m) => has.get(id).has(m)).map((m) => BUFKIT_MODEL_CODES[m]).join("")]));
}

// US and Canadian airports with IATA codes (ACARS profile IDs start with the IATA code).
// "Airport ID","Name","City","Country","IATA","ICAO","Latitude","Longitude","Altitude"(ft),...
async function airports() {
  const rows = [];
  for (const line of await fetchLines("AIRPORTS.csv")) {
    const f = (line.match(/("[^"]*"|[^,]*)(,|$)/g) ?? []).map((v) => v.replace(/,$/, "").replace(/^"|"$/g, ""));
    if (f.length < 9 || !["United States", "Canada"].includes(f[3]) || !/^[A-Z0-9]{3}$/.test(f[4])) continue;
    rows.push([f[4], f[1], f[2], round(Number(f[6])), round(Number(f[7])), Math.round(Number(f[8]) * 0.3048) || 0]);
  }
  return rows;
}

// ---- Natural Earth basemap layers, trimmed to what the map draws ----------------

const roundCoords = (c) => (typeof c[0] === "number" ? [round(c[0]), round(c[1])] : c.map(roundCoords));
const trim = (fc, keep = () => true) => ({
  type: "FeatureCollection",
  features: fc.features
    .filter((f) => f.geometry && keep(f.properties))
    .map((f) => ({ type: "Feature", properties: {}, geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) } })),
});

const lakes = async () => trim(await fetchJson(`${NE}/ne_50m_lakes.geojson`));
const highways = async () => trim(await fetchJson(`${NE}/ne_10m_roads.geojson`),
  (p) => p.continent === "North America" && p.type === "Major Highway");
// [name, lat, lon, min_zoom] — min_zoom decides when a town's label appears.
const places = async () => (await fetchJson(`${NE}/ne_10m_populated_places_simple.geojson`)).features
  .map(({ properties: p }) => [p.name, round(p.latitude), round(p.longitude), p.min_zoom])
  .sort((a, b) => a[3] - b[3]);

await mkdir(OUT, { recursive: true });
const outputs = {
  "raob-stations.json": raobStations,
  "bufkit-stations.json": bufkitStations,
  "airports.json": airports,
  "lakes-50m.json": lakes,
  "highways-na.json": highways,
  "places.json": places,
};
const only = process.argv.slice(2);
for (const [name, build] of Object.entries(outputs)) {
  if (only.length && !only.includes(name)) continue;
  const data = await build();
  await writeFile(new URL(name, OUT), JSON.stringify(data));
  console.log(`${name}: ${(data.features ?? data).length} entries`);
}

for (const [name, url] of Object.entries(BORDERS)) {
  if (only.length && !only.includes(name)) continue;
  const topo = await fetchJson(url);
  await writeFile(new URL(name, OUT), JSON.stringify(topo));
  console.log(`${name}: objects ${Object.keys(topo.objects).join(", ")}`);
}
