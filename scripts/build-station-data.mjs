// Builds the data used by the sounding-analysis maps: station and airport lists
// from SounderPy's station files, plus public-domain Natural Earth layers for the
// basemap. Re-run when those lists change:
//
//   node scripts/build-station-data.mjs
//   node scripts/build-station-data.mjs bufkit-stations.json   (just the files named)
//
// Station rows are compact arrays: [id, name, region, lat, lon, elevation_m]. BUFKIT rows add a
// seventh entry: the models with files for that station, as letters (see BUFKIT_MODEL_CODES).
// RAOB rows add the station's details from SounderPy's master list (see raobStations).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { mesh } from "topojson-client";

const SRC = "https://raw.githubusercontent.com/kylejgillett/sounderpy/main/src";
// SounderPy 3.3's RAOB/IGRA station list. It's on the development branch until 3.3.0 is released; then
// switch to main. RAOB_LIST can also name a local copy: RAOB_LIST=~/sounderpy/src/sounderpy/RAOB-STATIONS-MASTER.csv
const RAOB_LIST = process.env.RAOB_LIST
  ?? "https://raw.githubusercontent.com/kylejgillett/sounderpy/development/src/sounderpy/RAOB-STATIONS-MASTER.csv";
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

// One CSV line as trimmed fields. Quoted fields may hold commas ("Ny-Alesund II, Svalbard").
const csvFields = (line) => (line.match(/\s*("[^"]*"|[^,]*)\s*(,|$)/g) ?? [])
  .map((v) => v.trim().replace(/,$/, "").trim().replace(/^"|"$/g, ""));

// Which lists a station is in, as letters: the site shows them as "Listed by" in the station popup.
const RAOB_LIST_CODES = { IGRA2: "i", WYOMING: "w", OSCAR: "o", NCAR: "n", OLD_RAOB: "r" };

// One row per station with a location:
// [id, name, region, lat, lon, elevation_m, active (1/0), [first year, last year] of its IGRAv2 record or 0,
//  WMO, ICAO, IGRAv2 ID, other ICAO codes, former name, lists (RAOB_LIST_CODES), known data (1/0)].
// Known data: active, an IGRAv2 record, or seen in Wyoming's recent files. SounderPy warns on the rest
// (utils.raob_station_has_no_known_data), and the map fades them.
// The id is the one the form sends: ICAO, else WMO, else IGRAv2 (which SounderPy fetches from NOAA's IGRAv2).
async function raobStations() {
  const text = /^https?:/.test(RAOB_LIST)
    ? await fetchText(RAOB_LIST)
    : await readFile(RAOB_LIST.replace(/^~(?=\/)/, homedir()), "utf8");
  const [header, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const columns = csvFields(header);
  const rows = [];
  for (const line of lines) {
    const f = Object.fromEntries(csvFields(line).map((v, i) => [columns[i], v]));
    const lat = Number(f.LAT), lon = Number(f.LON);
    if (!f.LAT || !f.LON || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // "Norman, OK" -> Norman + OK; a name without a region gets the country code ("Jan Mayen", NO).
    const comma = f.DISPLAY_NAME.lastIndexOf(", ");
    const [name, region] = comma > 0 ? [f.DISPLAY_NAME.slice(0, comma), f.DISPLAY_NAME.slice(comma + 2)] : [f.DISPLAY_NAME || titleCase(f.NAME), f.CC];
    const record = f.IGRA_FIRST_YEAR && f.IGRA_LAST_YEAR ? [Number(f.IGRA_FIRST_YEAR), Number(f.IGRA_LAST_YEAR)] : 0;
    const formerName = f.OLD_NAME && titleCase(f.OLD_NAME) !== titleCase(name) ? titleCase(f.OLD_NAME) : "";
    const lists = f.SOURCES.split(/\s+/).map((s) => RAOB_LIST_CODES[s] ?? "").join("");
    rows.push([f.ICAO || f.WMO || f.IGRA_ID, name, region, round(lat), round(lon), Math.round(Number(f.ELEV_M)) || 0,
      f.ACTIVE === "Y" ? 1 : 0, record, f.WMO, f.ICAO, f.IGRA_ID, f.ICAO_ALT, formerName, lists,
      f.ACTIVE === "Y" || f.IGRA_ID || f.WYOMING_SEEN ? 1 : 0]);
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
let roadsJson; // ~50 MB, so it's downloaded once even when both road files are built
const neRoads = () => (roadsJson ??= fetchJson(`${NE}/ne_10m_roads.geojson`));
const highways = async () => trim(await neRoads(),
  (p) => p.continent === "North America" && p.type === "Major Highway");
// Every Natural Earth road around Grand Forks, for the UND uploader's map. `major` styles interstates.
const UND_BOX = { south: 45.5, north: 51, west: -101, east: -93 };
const undRoads = async () => {
  const touchesBox = (c) => (typeof c[0] === "number"
    ? c[1] > UND_BOX.south && c[1] < UND_BOX.north && c[0] > UND_BOX.west && c[0] < UND_BOX.east
    : c.some(touchesBox));
  const fc = await neRoads();
  return {
    type: "FeatureCollection",
    features: fc.features
      .filter((f) => f.geometry && touchesBox(f.geometry.coordinates))
      .map((f) => ({
        type: "Feature",
        properties: { major: f.properties.type === "Major Highway" ? 1 : 0 },
        geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
      })),
  };
};
// County lines in ND, MN, and SD for the UND map (Census, via us-atlas), only where they touch UND_BOX.
// Lines along state borders are left out, since the basemap already draws those.
const UND_STATES = ["38", "27", "46"]; // FIPS: North Dakota, Minnesota, South Dakota
const undCounties = async () => {
  const us = await fetchJson("https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/counties-10m.json");
  const counties = { ...us.objects.counties, geometries: us.objects.counties.geometries.filter((g) => UND_STATES.includes(g.id.slice(0, 2))) };
  const lines = mesh(us, counties, (a, b) => a !== b && a.id.slice(0, 2) === b.id.slice(0, 2)).coordinates;
  const inBox = ([lon, lat]) => lat > UND_BOX.south && lat < UND_BOX.north && lon > UND_BOX.west && lon < UND_BOX.east;
  const fine = (n) => Math.round(n * 1000) / 1000; // ~100 m, so county corners stay sharp zoomed in
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature", properties: {},
      geometry: { type: "MultiLineString", coordinates: lines.filter((l) => l.some(inBox)).map((l) => l.map(([x, y]) => [fine(x), fine(y)])) },
    }],
  };
};
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
  "und-roads.json": undRoads,
  "und-counties.json": undCounties,
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
