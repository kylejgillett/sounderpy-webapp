// Leaflet maps for the sounding-analysis page. Imported on demand, so Leaflet
// only downloads once someone opens a data-source tab.

import L from "leaflet";
import { feature, mesh } from "topojson-client";
import "leaflet/dist/leaflet.css";
import "../styles/station-map.css";

// Basemap drawn from Natural Earth data (public domain), so there are no tile servers or
// API keys involved. An earthy prairie palette: wheat land, blue-tinged sage water, dark
// umber boundaries and rust highways. It's lighter than the page, so it stands apart.
const OCEAN = "#3a4749";
const BASE = {
  land: { stroke: true, color: "#2c2820", weight: 1, fillColor: "#5c5443", fillOpacity: 1 },
  lakes: { stroke: true, color: "#2c2820", weight: 0.7, fillColor: OCEAN, fillOpacity: 1 },
  highways: { color: "#a86c4c", weight: 1, opacity: 0.75 },
  countries: { color: "#231f19", weight: 1.3, opacity: 0.9 },
  states: { color: "#38332a", weight: 0.8, opacity: 0.85 },
  graticule: { color: "#4a5556", weight: 1, dashArray: "2 4" },
};
const HIGHWAY_MIN_ZOOM = 5;
const DIM_LABEL_MIN_ZOOM = 6; // faded (inactive) stations get their labels at a state-sized view
const MAX_PLACE_LABELS = 120;
const DATA = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/data/`;

export async function fetchData(file) {
  const res = await fetch(DATA + file);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.json();
}

let basemapData;
function loadBasemap() {
  basemapData ??= Promise.all(
    ["world-50m.json", "us-states-10m.json", "lakes-50m.json", "places.json"].map(fetchData),
  ).then(([world, us, lakes, places]) => ({
    land: crossAntimeridian(feature(world, world.objects.land)),
    countries: crossAntimeridian(mesh(world, world.objects.countries, (a, b) => a !== b)),
    states: mesh(us, us.objects.states, (a, b) => a !== b),
    lakes, places,
  }));
  return basemapData;
}

// Highways only show zoomed in, so they download the first time someone gets there.
let highwayData;
const loadHighways = () => (highwayData ??= fetchData("highways-na.json"));

/**
 * Natural Earth cuts shapes at the 180° meridian, so a ring that crosses it (Chukotka, Wrangel Island, Fiji)
 * jumps from +180 to -180 in one step. Leaflet draws that step as a line across the whole map. Here each
 * ring runs on continuously past 180 instead, and a copy shifted 360° fills in the other side of the map.
 */
function crossAntimeridian(geojson) {
  const unwrap = (line) => {
    let shift = 0;
    return line.map(([lon, lat], i) => {
      if (i) {
        const step = lon + shift - line[i - 1][0] - shift;
        if (step > 180) shift -= 360;
        else if (step < -180) shift += 360;
      }
      return [lon + shift, lat];
    });
  };
  const offset = (coords, by) => (typeof coords[0] === "number" ? [coords[0] + by, coords[1]] : coords.map((c) => offset(c, by)));
  const lons = (coords) => (typeof coords[0] === "number" ? [coords[0]] : coords.flatMap(lons));
  // [part, part shifted to the other side] for a part that now reaches past ±180.
  const withCopy = (part) => {
    const all = lons(part), max = Math.max(...all), min = Math.min(...all);
    return max > 180 ? [part, offset(part, -360)] : min < -180 ? [part, offset(part, 360)] : [part];
  };
  const fix = (geometry) => {
    switch (geometry.type) {
      case "Polygon": return { type: "MultiPolygon", coordinates: withCopy(geometry.coordinates.map(unwrap)) };
      case "MultiPolygon": return { type: "MultiPolygon", coordinates: geometry.coordinates.flatMap((poly) => withCopy(poly.map(unwrap))) };
      case "LineString": return { type: "MultiLineString", coordinates: withCopy(unwrap(geometry.coordinates)) };
      case "MultiLineString": return { type: "MultiLineString", coordinates: geometry.coordinates.flatMap((line) => withCopy(unwrap(line))) };
      default: return geometry;
    }
  };
  if (geojson.type === "FeatureCollection") return { ...geojson, features: geojson.features.map((f) => ({ ...f, geometry: fix(f.geometry) })) };
  if (geojson.type === "Feature") return { ...geojson, geometry: fix(geojson.geometry) };
  return fix(geojson);
}

// Town labels: the most important places that fit the current zoom and view. A small map shows fewer.
// Labels that stay in view are kept rather than rebuilt, so panning doesn't redraw them all.
function placeLabels(map, places) {
  const layer = L.layerGroup().addTo(map);
  const shown = new Map(); // place -> marker
  const update = () => {
    const zoom = map.getZoom(), bounds = map.getBounds().pad(0.05), size = map.getSize();
    const limit = Math.max(30, Math.round(MAX_PLACE_LABELS * Math.min(1, (size.x * size.y) / (800 * 450))));
    const keep = new Set();
    for (const place of places) {
      const [, lat, lon, minZoom] = place;
      if (minZoom > zoom || keep.size >= limit) break;
      if (bounds.contains([lat, lon])) keep.add(place);
    }
    for (const [place, marker] of shown) if (!keep.has(place)) { layer.removeLayer(marker); shown.delete(place); }
    for (const place of keep) {
      if (shown.has(place)) continue;
      const [name, lat, lon] = place;
      shown.set(place, L.marker([lat, lon], {
        pane: "labels", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "spy-place", html: `<span>${esc(name)}</span>`, iconSize: null }),
      }).addTo(layer));
    }
  };
  map.on("moveend", update);
  update();
}

function graticule(step = 10) {
  const lines = [];
  for (let lat = -80; lat <= 80; lat += step) lines.push([[lat, -180], [lat, 180]]);
  for (let lon = -180; lon <= 180; lon += step) lines.push([[-85, lon], [85, lon]]);
  return lines;
}

async function drawBasemap(map) {
  // Three canvases, bottom to top: land and water, highways, borders. Highways get their own so they can come
  // and go with the zoom without redrawing (or reordering) the rest. Extra padding draws past the edges, so a
  // pan shows map instead of empty ocean until the redraw.
  const canvasPane = (name, zIndex) => {
    map.createPane(name).style.zIndex = zIndex;
    return { pane: name, renderer: L.canvas({ pane: name, padding: 0.5 }), interactive: false };
  };
  const base = canvasPane("basemap", 200), roadLayer = canvasPane("roads", 201), borderLayer = canvasPane("borders", 202);
  map.createPane("labels").style.zIndex = 350; // above the basemap, below station dots
  L.polyline(graticule(), { ...base, ...BASE.graticule }).addTo(map);

  const { land, lakes, countries, states, places } = await loadBasemap();
  for (const [shape, style] of [[land, BASE.land], [lakes, BASE.lakes]]) {
    L.geoJSON(shape, { ...base, style }).addTo(map);
  }
  for (const [shape, style] of [[countries, BASE.countries], [states, BASE.states]]) {
    L.geoJSON(shape, { ...borderLayer, style }).addTo(map);
  }

  // Highways only once zoomed in to a region; at continent scale they're clutter, and drawing them costs time.
  let roads = null;
  const toggleRoads = async () => {
    const show = map.getZoom() >= HIGHWAY_MIN_ZOOM;
    if (show && !roads) {
      roads = L.geoJSON(await loadHighways(), { ...roadLayer, style: BASE.highways });
    }
    if (roads && show !== map.hasLayer(roads)) (show ? roads.addTo(map) : roads.remove());
  };
  map.on("zoomend", () => toggleRoads().catch((err) => console.error("Highways failed to load", err)));
  toggleRoads().catch((err) => console.error("Highways failed to load", err));
  placeLabels(map, places);
}

// Markers get a dark outline so they read clearly over both the basemap and radar echoes.
const COLORS = { dot: "#f3ead6", edge: "#1a1712", picked: "#ffffff", pickedEdge: "#e0a93b", airport: "#c9784f" };
const DOT = { radius: 4.5, weight: 1.5, color: COLORS.edge, fillColor: COLORS.dot, fillOpacity: 1 };
const PICKED = { radius: 8, weight: 3, color: COLORS.pickedEdge, fillColor: COLORS.picked, fillOpacity: 1 };
// Background reference points (e.g. every airport on the ACARS map).
const LAUNCHED = { radius: 9, weight: 1.5, color: COLORS.edge, fillColor: "#7fc28a", fillOpacity: 1 };
const LAUNCHED_OLDER = { ...LAUNCHED, fillColor: "#a9a88a" };
export const FAINT_DOT = { radius: 3, weight: 1, color: COLORS.edge, fillColor: "#cdc3a9", fillOpacity: 0.8 };

// ---- Live radar: IEM's NEXRAD base-reflectivity composite (CONUS, every 5 minutes) ----

const RADAR_TILES = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png";
const RADAR_META = "https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.json";
const RADAR_REFRESH = 5 * 60_000;

async function radarValidTime() {
  const res = await fetch(RADAR_META, { cache: "no-store" });
  if (!res.ok) throw new Error(`radar metadata: HTTP ${res.status}`);
  return (await res.json()).meta.valid; // e.g. "2026-10-29T20:40:00Z"
}

// Radar sits between the basemap and the town labels, with an on/off toggle that shows its time.
function addRadar(map) {
  const pane = map.createPane("radar");
  pane.style.zIndex = 300;
  pane.style.pointerEvents = "none";
  const tiles = L.tileLayer(RADAR_TILES, {
    pane: "radar", opacity: 0.65,
    attribution: 'Radar: <a href="https://mesonet.agron.iastate.edu/">Iowa Environmental Mesonet</a>',
  }).addTo(map);

  const toggle = L.control({ position: "topright" });
  toggle.onAdd = () => {
    const box = L.DomUtil.create("label", "spy-radar-toggle");
    box.innerHTML = '<input type="checkbox" checked /><span>Radar</span><time>…</time>';
    L.DomEvent.disableClickPropagation(box);
    box.querySelector("input").addEventListener("change", (e) => (e.target.checked ? tiles.addTo(map) : tiles.remove()));
    return box;
  };
  toggle.addTo(map);
  const time = toggle.getContainer().querySelector("time");

  async function refresh() {
    try {
      const valid = await radarValidTime();
      tiles.setUrl(`${RADAR_TILES}?valid=${encodeURIComponent(valid)}`); // new frame, new URL: no stale cached tiles
      time.dateTime = valid;
      time.textContent = `${valid.slice(11, 16)}Z`;
      time.title = `NEXRAD composite valid ${valid.replace("T", " ").replace(":00Z", " UTC")}`;
    } catch {
      time.textContent = "unavailable";
    }
  }
  refresh();
  setInterval(refresh, RADAR_REFRESH);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createBaseMap(el, { center = [39, -96], zoom = 4 } = {}) {
  const map = L.map(el, {
    center, zoom, minZoom: 2, maxZoom: 9, preferCanvas: true,
    // On phones one finger scrolls the page (the map fills the screen width); two fingers move the map.
    dragging: !L.Browser.mobile,
    zoomSnap: 0.5, wheelPxPerZoomLevel: 90,
    maxBounds: [[-85, -200], [85, 200]], maxBoundsViscosity: 0.8,
  });
  map.attributionControl.addAttribution('Map data: <a href="https://www.naturalearthdata.com/">Natural Earth</a>');
  drawBasemap(map).catch((err) => console.error("Basemap failed to load", err));
  addRadar(map);
  if (L.Browser.mobile) touchHint(map);
  // The map stretches to its column's height, which changes as the form beside it grows.
  new ResizeObserver(() => map.invalidateSize()).observe(el);
  return map;
}

// On phones one finger scrolls the page. If someone tries to drag the map with one, say how to move it,
// briefly, over the map (like other embedded maps do) rather than keeping a note on it all the time.
function touchHint(map) {
  const hint = L.DomUtil.create("div", "spy-map-touch-hint", map.getContainer());
  hint.textContent = "Use two fingers to move the map";
  hint.setAttribute("aria-hidden", "true");
  let start = null, timer = null;
  const el = map.getContainer();
  el.addEventListener("touchstart", (e) => { start = e.touches.length === 1 ? e.touches[0] : null; }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (!start || e.touches.length !== 1) { hint.classList.remove("is-shown"); return; }
    const t = e.touches[0];
    if (Math.hypot(t.clientX - start.clientX, t.clientY - start.clientY) < 12) return;
    hint.classList.add("is-shown");
    clearTimeout(timer);
    timer = setTimeout(() => hint.classList.remove("is-shown"), 1500);
  }, { passive: true });
}

/** Popup options that keep a popup inside a narrow map. */
export const popupOptions = (map) => ({
  className: "spy-popup", maxWidth: Math.min(300, map.getSize().x - 48), autoPanPadding: [12, 12],
});

// BUFKIT rows carry their models as letters (scripts/build-station-data.mjs). NAM & NAMNEST are past runs only.
export const BUFKIT_MODEL_CODES = { hrrr: "h", rrfs: "r", rap: "a", gfs: "g", nam: "n", namnest: "m" };
const ARCHIVE_ONLY_CODES = "nm";

function modelLines(codes) {
  const names = (keep) => Object.entries(BUFKIT_MODEL_CODES)
    .filter(([, code]) => codes.includes(code) && keep(code)).map(([model]) => model.toUpperCase());
  const latest = names((code) => !ARCHIVE_ONLY_CODES.includes(code)), past = names((code) => ARCHIVE_ONLY_CODES.includes(code));
  return (latest.length ? `<small class="spy-popup-models">Models: ${latest.join(" · ")}</small>` : "")
    + (past.length ? `<small>Past runs only: ${past.join(" · ")}</small>` : "");
}

function stationPopup([id, name, region, , , elev, models]) {
  return `<strong>${esc(id)}</strong><span>${esc([name, region].filter(Boolean).join(", "))}</span>`
    + (models ? modelLines(models) : "")
    + `<small>${esc(elev)} m elevation · added to the form</small>`;
}

/** A BUFKIT station's details, for the station card beside the map. */
export function bufkitCard([id, name, region, , , elev, models]) {
  return `<strong>${esc(id)}</strong><span>${esc([name, region].filter(Boolean).join(", "))}</span>`
    + `<small>${esc(elev)} m elevation</small>`
    + (models ? modelLines(models) : "");
}

// RAOB rows (scripts/build-station-data.mjs): [id, name, region, lat, lon, elev, active, record, wmo, icao, igra,
// other ICAO codes, former name, lists, known data]. Lists are letters for the station lists SounderPy's master list
// draws on. Known data is 0 for stations that aren't active, have no IGRAv2 record and aren't in Wyoming's recent files.
const RAOB_LISTS = { i: "IGRAv2", w: "Wyoming", o: "WMO OSCAR", n: "NCAR" }; // r (SounderPy's old list) isn't shown
export const raobActive = (row) => row[6] === 1;
export const raobHasData = (row) => row[14] === 1;

/** Every ID a RAOB station goes by: the form takes any of them. U.S. ICAO codes also work without the K. */
export function raobIds(row) {
  const [id, , , , , , , , wmo, icao, igra, other] = row;
  const ids = [id, icao, wmo, igra, ...other.split(" ")].filter(Boolean);
  return [...ids, ...ids.filter((v) => /^K[A-Z]{3}$/.test(v)).map((v) => v.slice(1))];
}

/** The ID to fetch a station's soundings with. Inactive stations use IGRAv2, which holds their whole record. */
export const raobFetchId = (row) => (!raobActive(row) && row[10]) || row[0];

/** A RAOB station's details, for the station card beside the map. Its ID buttons put that ID in the form (data-use-id). */
export function raobPopup(row, current) {
  const [id, name, region, , , elev, active, record, wmo, icao, igra, other, former, lists] = row;
  const idButton = (label, value) => value
    ? `<button type="button" data-use-id="${esc(value)}" aria-pressed="${value === current}">${label} ${esc(value)}</button>` : "";
  const years = record ? `IGRAv2 record ${record[0]}–${record[1]}`
    : raobHasData(row) ? "No IGRAv2 record" : "No IGRAv2 record or recent Wyoming data";
  const listedBy = [...lists].map((code) => RAOB_LISTS[code]).filter(Boolean);
  return `<strong>${esc(id)}</strong><span>${esc([name, region].filter(Boolean).join(", "))}</span>`
    + `<small>${esc(elev)} m elevation</small>`
    + `<small class="${active ? "spy-popup-active" : "spy-popup-inactive"}">${active ? "Active" : "Inactive"} · ${years}</small>`
    + `<div class="spy-popup-ids">${idButton("ICAO", icao)}${idButton("WMO", wmo)}${idButton("IGRAv2", igra)}</div>`
    + `<small>Pick an ID to get data. ICAO and WMO are fastest; IGRAv2 can take up to a minute.</small>`
    + (other ? `<small>Also coded ${esc(other.split(" ").join(", "))}</small>` : "")
    + (former ? `<small>Formerly ${esc(former)}</small>` : "")
    + (listedBy.length ? `<small>Listed by ${esc(listedBy.join(" · "))}</small>` : "")
    + `<small class="spy-popup-sources">Sources: WMO/ICAO: Univ. of Wyoming | IGRAv2: NOAA IGRAv2</small>`;
}

// At most one station per CELL x CELL pixel square at the current zoom, so dense areas stay readable.
const CELL = 44;

/**
 * Clickable station dots with faded ID labels, thinned out by zoom.
 * rows: [id, name, region, lat, lon, elev, ...]. Options: `ids(row)` lists every ID a station can be
 * found by (default: its own); `popupHtml(row, typedId)` writes its popup; `note(row)` adds to its tooltip.
 * A popup button with data-use-id calls onPick(row, thatId). onPick may return the ID it put in the form.
 * `onSelect(row, typedId)` runs whenever the picked station changes (row is null when nothing matches), so a
 * page can show the station's details outside the map, as the RAOB tab does with popup: false.
 * `dim(row)` fades a station's dot and holds its label back until DIM_LABEL_MIN_ZOOM (inactive RAOB sites).
 * `hidden(row)` leaves a station off the map, though its IDs still find it (RAOB sites with no known data).
 *
 * Each station's dot and label are one HTML marker, so they glide together while the map zooms
 * (canvas dots stretch mid-zoom and then snap back). Thinning waits until the map settles.
 */
export function stationLayer(map, rows, { onPick, onSelect = () => {}, style = DOT, popup = true, ids = (row) => [row[0]], popupHtml = stationPopup, note = () => "", dim = () => false, hidden = () => false }) {
  if (!map.getPane("stations")) {
    const pane = map.createPane("stations");
    pane.style.zIndex = 450;
    pane.style.pointerEvents = "none"; // only the dots take clicks, not the labels or the gaps
  }
  // Faded stations' labels wait for a state-sized view, so wider views stay readable.
  const stationPane = map.getPane("stations");
  const toggleDimLabels = () => stationPane.classList.toggle("show-dim-labels", map.getZoom() >= DIM_LABEL_MIN_ZOOM);
  map.on("zoomend", toggleDimLabels);
  toggleDimLabels();
  const entries = new Map();
  let picked = null;
  let launched = new Map(), launchedOnly = false; // id -> { hour, when, fresh }
  let available = () => true; // stations without the chosen model fade and give way to the rest
  const launchOf = (entry) => launched.get(entry.row[0].toUpperCase());
  const launchStyle = (launch) => (launch.fresh ? LAUNCHED : LAUNCHED_OLDER);
  // The dot's outer size matches what a circleMarker with this radius and outline drew.
  const stationIcon = (id, s, hour, faded = false, isPicked = false, dimmed = false) => L.divIcon({
    className: ["spy-station", faded && "is-unavailable", dimmed && "is-dim", isPicked && "is-picked"].filter(Boolean).join(" "),
    html: `<i style="--d:${2 * s.radius + s.weight}px;--w:${s.weight}px;--edge:${s.color};--fill:${s.fillColor};--o:${s.fillOpacity}"></i>`
      + `<span class="${hour ? "has-launch" : ""}">${esc(id)}</span>`
      + `${hour ? `<b>${esc(hour)}</b>` : ""}`,
    iconSize: null,
  });
  const restyle = (entry) => {
    const launch = launchOf(entry);
    const s = entry === picked ? { ...PICKED, radius: launch ? LAUNCHED.radius : PICKED.radius } : launch ? launchStyle(launch) : style;
    // A launch shows the station is in use, so it isn't faded even if the list calls it inactive.
    const plain = entry !== picked && !launch;
    entry.marker.setIcon(stationIcon(entry.row[0], s, launch?.hour, plain && !available(entry.row), entry === picked, plain && dim(entry.row)));
    entry.marker.setZIndexOffset(entry === picked ? 1000 : launch ? 500 : 0);
  };

  // Main sites (4-character IDs like KOAX) win when stations crowd the same spot.
  const ordered = [...rows].sort((a, b) => (b[0].length === 4) - (a[0].length === 4));
  const tooltip = (row, launch) => `${esc(row[0])} · ${esc(row[1])}${esc(note(row))}${launch ? `<br>Launch: ${esc(launch.when)}` : ""}`;
  for (const row of ordered) {
    const marker = L.marker([row[3], row[4]], { pane: "stations", icon: stationIcon(row[0], style, null, false, false, dim(row)) })
      .bindTooltip(tooltip(row), { direction: "top", offset: [0, -4] })
      .on("click", () => { const used = onPick(row); select(used ?? row[0]); });
    entries.set(row[0].toUpperCase(), { marker, row });
  }
  // Other IDs find the same station. A station's own ID always wins over another station's alias.
  const byId = new Map();
  for (const entry of entries.values()) {
    for (const id of ids(entry.row)) if (!byId.has(id.toUpperCase()) || id === entry.row[0]) byId.set(id.toUpperCase(), entry);
  }
  map.on("popupopen", (e) => {
    const entry = e.popup._source && [...entries.values()].find((item) => item.marker === e.popup._source);
    if (!entry) return;
    e.popup.getElement().querySelectorAll("[data-use-id]").forEach((button) => button.addEventListener("click", () => {
      e.popup.getElement().querySelectorAll("[data-use-id]").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      onPick(entry.row, button.dataset.useId);
    }));
  });

  function update() {
    const zoom = map.getZoom(), bounds = map.getBounds().pad(0.2);
    const taken = new Set(), visible = new Set();
    const claim = (entry) => {
      const p = map.project(entry.marker.getLatLng(), zoom);
      const cell = `${Math.floor(p.x / CELL)}:${Math.floor(p.y / CELL)}`;
      if (taken.has(cell)) return;
      taken.add(cell);
      visible.add(entry);
    };
    if (picked) { claim(picked); visible.add(picked); }
    // Launched sites win the crowded spots too.
    const isLaunched = (entry) => launched.has(entry.row[0].toUpperCase());
    const inView = [...entries.values()].filter((entry) => entry !== picked && (isLaunched(entry) || !hidden(entry.row))
      && bounds.contains(entry.marker.getLatLng()));
    inView.filter(isLaunched).forEach(claim);
    if (!launchedOnly) {
      const rest = inView.filter((entry) => !isLaunched(entry));
      const bright = (entry) => available(entry.row) && !dim(entry.row);
      rest.filter(bright).forEach(claim);
      rest.filter((entry) => !bright(entry)).forEach(claim);
    }
    for (const entry of entries.values()) {
      const show = visible.has(entry);
      if (show && !map.hasLayer(entry.marker)) entry.marker.addTo(map);
      else if (!show && map.hasLayer(entry.marker)) entry.marker.remove();
    }
  }
  // A scroll-wheel zoom is several small zooms in a row; thin out once, when the map comes to rest.
  let settle = null;
  map.on("movestart zoomstart", () => clearTimeout(settle));
  map.on("moveend", () => { clearTimeout(settle); settle = setTimeout(update, 120); });
  update();

  function select(id, { pan = false } = {}) {
    const typed = String(id).trim().toUpperCase();
    const hit = byId.get(typed);
    const previous = picked;
    picked = hit ?? null;
    if (previous) restyle(previous);
    onSelect(hit?.row ?? null, typed);
    if (!hit) return false;
    restyle(hit);
    update(); // make sure the picked station is shown even where its neighbours win
    if (popup) hit.marker.bindPopup(popupHtml(hit.row, typed), popupOptions(map)).openPopup();
    if (pan) map.setView(hit.marker.getLatLng(), Math.max(map.getZoom(), 6));
    return true;
  }

  /** Show each launch's hour inside its site's icon. `only` hides the rest (the picked site always stays). */
  function setLaunches(launches, only) {
    launched = launches;
    launchedOnly = only;
    entries.forEach((entry) => {
      restyle(entry);
      entry.marker.setTooltipContent(tooltip(entry.row, launchOf(entry)));
    });
    update();
  }

  /** Fade the stations a filter rejects, such as those without the chosen model. */
  function setAvailable(filter) {
    available = filter;
    entries.forEach(restyle);
    update();
  }

  return { select, setLaunches, setAvailable };
}

/**
 * Which launches the map shows. onSelect(view) runs with the chosen view.
 * Top right, by the radar toggle: wide maps get one row of buttons beside it, narrow ones (phones) a
 * single "Launches" menu under it, which takes far less of the map.
 */
export function launchControl(map, views, onSelect) {
  map.attributionControl.addAttribution('Launches: <a href="https://mesonet.agron.iastate.edu/">IEM</a>');
  const compact = map.getSize().x < 520;
  const control = L.control({ position: "topright" });
  control.onAdd = () => {
    const box = L.DomUtil.create("div", `spy-launch-views ${compact ? "is-menu" : "is-row"}`);
    if (compact) {
      box.innerHTML = `<label>Launches <select aria-label="Launches to show">${views.map(([view, text]) => `<option value="${esc(view)}">${esc(text)}</option>`).join("")}</select></label>`;
      box.querySelector("select").addEventListener("change", (e) => onSelect(e.target.value));
    } else {
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", "Launches to show");
      box.innerHTML = `<span>Launches</span>` + views.map(([view, text]) => `<button type="button" data-view="${esc(view)}" aria-pressed="false">${esc(text)}</button>`).join("");
      box.addEventListener("click", (e) => {
        const view = e.target.closest("button")?.dataset.view;
        if (view) onSelect(view);
      });
    }
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);
    return box;
  };
  control.addTo(map);
  const box = control.getContainer();
  const item = (view) => box.querySelector(compact ? `option[value="${view}"]` : `[data-view="${view}"]`);
  return {
    setActive(active) {
      if (compact) box.querySelector("select").value = active;
      else for (const [view] of views) item(view).setAttribute("aria-pressed", String(view === active));
    },
    setView(view, { title = "", disabled = false } = {}) {
      item(view).title = title;
      item(view).disabled = disabled;
    },
    setLoading(view, loading) {
      (compact ? box : item(view)).classList.toggle("is-loading", loading);
    },
  };
}

/** Click anywhere to drop a pin (reanalysis points). */
export function pointPicker(map, { onPick }) {
  const pin = L.circleMarker([0, 0], PICKED);

  function set(lat, lon, { pan = false } = {}) {
    pin.setLatLng([lat, lon]).addTo(map);
    if (pan) map.setView([lat, lon], Math.max(map.getZoom(), 6));
  }

  map.on("click", (e) => {
    const lat = Math.round(e.latlng.lat * 100) / 100;
    const lon = Math.round(L.Util.wrapNum(e.latlng.lng, [-180, 180]) * 100) / 100;
    set(lat, lon);
    onPick(lat, lon);
  });

  return { set };
}

/**
 * Airports that have ACARS profiles. Each popup lists that airport's profile times
 * as buttons. `focus` ({ code, lat, lon }) is the airport the user clicked: its popup
 * opens straight away (or says nothing was found) instead of zooming to all results.
 */
export function airportLayer(map, { onPick }) {
  // Above the faint airport dots. SVG, unlike canvas, lets clicks through to the airports beneath.
  if (!map.getPane("results")) {
    const pane = map.createPane("results");
    pane.style.zIndex = 460;
    pane.style.pointerEvents = "none";
  }
  const renderer = L.svg({ pane: "results" });
  const layer = L.featureGroup().addTo(map);
  const count = (n) => `${n} profile${n === 1 ? "" : "s"}`;
  const popupAt = (focus, html) => L.popup(popupOptions(map)).setLatLng([focus.lat, focus.lon]).setContent(html).openOn(map);

  function searching(focus) {
    layer.clearLayers();
    popupAt(focus, `<strong>${esc(focus.code)}</strong><small class="spy-popup-busy">Searching all 24 hours for flights…</small>`);
  }

  function show(profiles, { focus } = {}) {
    layer.clearLayers();
    const byAirport = new Map();
    for (const p of profiles) {
      if (p.lat == null || p.lon == null) continue;
      if (!byAirport.has(p.code)) byAirport.set(p.code, []);
      byAirport.get(p.code).push(p);
    }

    let focused = null;
    for (const [code, list] of byAirport) {
      const { lat, lon, airport } = list[0];
      const popup = document.createElement("div");
      popup.innerHTML = `<strong>${esc(code)}</strong><span>${esc(airport)}</span><small>${count(list.length)}. Pick one to plot:</small>`;
      const buttons = document.createElement("div");
      buttons.className = "spy-popup-choices";
      for (const p of list) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = `${p.id.slice(4, 6)}:${p.id.slice(6, 8)}Z`;
        b.title = p.id;
        b.addEventListener("click", () => { onPick(p); map.closePopup(); });
        buttons.append(b);
      }
      popup.append(buttons);

      const marker = L.circleMarker([lat, lon], { ...DOT, radius: 5 + Math.min(list.length, 6), fillColor: COLORS.airport, pane: "results", renderer })
        .bindTooltip(`${esc(code)} · ${count(list.length)}`, { direction: "top" })
        .bindPopup(popup, popupOptions(map))
        .addTo(layer);
      if (focus && code === focus.code.toUpperCase()) focused = marker;
    }

    if (focus) {
      if (focused) focused.openPopup();
      else popupAt(focus, `<strong>${esc(focus.code)}</strong><small>No ACARS profiles on this date. Try another day or a nearby airport.</small>`);
    } else if (layer.getLayers().length) {
      map.fitBounds(layer.getBounds().pad(0.2), { maxZoom: 7 });
    }
  }

  return { show, searching };
}
