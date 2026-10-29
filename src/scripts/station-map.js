// Leaflet maps for the sounding-analysis page. Imported on demand, so Leaflet
// only downloads once someone opens a data-source tab.

import L from "leaflet";
import { feature, mesh } from "topojson-client";
import "leaflet/dist/leaflet.css";
import "../styles/station-map.css";

// Basemap drawn from Natural Earth data (public domain), so there are no tile servers or
// API keys involved. A cool slate "chart" palette sets the map apart from the warm page;
// station dots and highways stay warm so they stand out on it.
const OCEAN = "#1d252b";
const BASE = {
  land: { stroke: true, color: "#7f97a3", weight: 0.9, fillColor: "#323a3f", fillOpacity: 1 },
  lakes: { stroke: true, color: "#5d7480", weight: 0.6, fillColor: OCEAN, fillOpacity: 1 },
  highways: { color: "#b08d62", weight: 1, opacity: 0.7 },
  countries: { color: "#a9b9c1", weight: 1.1, opacity: 0.95 },
  states: { color: "#5e6c73", weight: 0.7, opacity: 0.95 },
  graticule: { color: "#283239", weight: 1, dashArray: "2 4" },
};
const HIGHWAY_MIN_ZOOM = 5;
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
    ["world-50m.json", "us-states-10m.json", "lakes-50m.json", "highways-na.json", "places.json"].map(fetchData),
  ).then(([world, us, lakes, highways, places]) => ({
    land: feature(world, world.objects.land),
    countries: mesh(world, world.objects.countries, (a, b) => a !== b),
    states: mesh(us, us.objects.states, (a, b) => a !== b),
    lakes, highways, places,
  }));
  return basemapData;
}

// Town labels: the most important places that fit the current zoom and view.
function placeLabels(map, places) {
  const layer = L.layerGroup().addTo(map);
  const update = () => {
    const zoom = map.getZoom(), bounds = map.getBounds().pad(0.05);
    layer.clearLayers();
    let shown = 0;
    for (const [name, lat, lon, minZoom] of places) {
      if (minZoom > zoom || shown >= MAX_PLACE_LABELS) break;
      if (!bounds.contains([lat, lon])) continue;
      L.marker([lat, lon], {
        pane: "labels", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "spy-place", html: `<span>${esc(name)}</span>`, iconSize: null }),
      }).addTo(layer);
      shown++;
    }
  };
  map.on("moveend zoomend", update);
  update();
}

function graticule(step = 10) {
  const lines = [];
  for (let lat = -80; lat <= 80; lat += step) lines.push([[lat, -180], [lat, 180]]);
  for (let lon = -180; lon <= 180; lon += step) lines.push([[-85, lon], [85, lon]]);
  return lines;
}

async function drawBasemap(map) {
  map.createPane("basemap").style.zIndex = 200;
  map.createPane("labels").style.zIndex = 350; // above the basemap, below station dots
  const renderer = L.canvas({ pane: "basemap" });
  const layer = { pane: "basemap", renderer, interactive: false };
  L.polyline(graticule(), { ...layer, ...BASE.graticule }).addTo(map);

  const { land, lakes, highways, countries, states, places } = await loadBasemap();
  for (const [shape, style] of [[land, BASE.land], [lakes, BASE.lakes]]) {
    L.geoJSON(shape, { ...layer, style }).addTo(map);
  }
  const roads = L.geoJSON(highways, { ...layer, style: BASE.highways }).addTo(map);
  for (const [shape, style] of [[countries, BASE.countries], [states, BASE.states]]) {
    L.geoJSON(shape, { ...layer, style }).addTo(map);
  }

  // Highways only once zoomed in to a region; at continent scale they're clutter.
  // (Faded rather than removed, so they keep their place between lakes and borders.)
  const toggleRoads = () => roads.setStyle({ opacity: map.getZoom() >= HIGHWAY_MIN_ZOOM ? BASE.highways.opacity : 0 });
  map.on("zoomend", toggleRoads);
  toggleRoads();
  placeLabels(map, places);
}

// Markers get a dark outline so they read clearly over both the basemap and radar echoes.
const COLORS = { dot: "#f3ead6", edge: "#0d1215", picked: "#ffffff", pickedEdge: "#e0a93b", airport: "#e2876a" };
const DOT = { radius: 4.5, weight: 1.5, color: COLORS.edge, fillColor: COLORS.dot, fillOpacity: 1 };
const PICKED = { radius: 8, weight: 3, color: COLORS.pickedEdge, fillColor: COLORS.picked, fillOpacity: 1 };
// Background reference points (e.g. every airport on the ACARS map).
export const FAINT_DOT = { radius: 3, weight: 1, color: COLORS.edge, fillColor: "#b9c6cc", fillOpacity: 0.8 };

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
    zoomSnap: 0.5, wheelPxPerZoomLevel: 90,
    maxBounds: [[-85, -200], [85, 200]], maxBoundsViscosity: 0.8,
  });
  map.attributionControl.addAttribution('Map data: <a href="https://www.naturalearthdata.com/">Natural Earth</a>');
  drawBasemap(map).catch((err) => console.error("Basemap failed to load", err));
  addRadar(map);
  // The map stretches to its column's height, which changes as the form beside it grows.
  new ResizeObserver(() => map.invalidateSize()).observe(el);
  return map;
}

function stationPopup([id, name, region, , , elev]) {
  return `<strong>${esc(id)}</strong><span>${esc([name, region].filter(Boolean).join(", "))}</span><small>${esc(elev)} m elevation · added to the form</small>`;
}

/** Clickable station dots. rows: [id, name, region, lat, lon, elev]. */
export function stationLayer(map, rows, { onPick, style = DOT, popup = true }) {
  const markers = new Map();
  let picked = null;

  for (const row of rows) {
    const marker = L.circleMarker([row[3], row[4]], style)
      .bindTooltip(`${esc(row[0])} · ${esc(row[1])}`, { direction: "top", offset: [0, -4] })
      .on("click", () => { select(row[0]); onPick(row); })
      .addTo(map);
    markers.set(row[0].toUpperCase(), { marker, row });
  }

  function select(id, { pan = false } = {}) {
    const hit = markers.get(String(id).trim().toUpperCase());
    if (picked) picked.marker.setStyle(style);
    picked = hit ?? null;
    if (!hit) return false;
    hit.marker.setStyle(PICKED).bringToFront();
    if (popup) hit.marker.bindPopup(stationPopup(hit.row), { className: "spy-popup" }).openPopup();
    if (pan) map.setView(hit.marker.getLatLng(), Math.max(map.getZoom(), 6));
    return true;
  }

  return { select };
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
  const layer = L.featureGroup().addTo(map);
  const count = (n) => `${n} profile${n === 1 ? "" : "s"}`;
  const popupAt = (focus, html) => L.popup({ className: "spy-popup" }).setLatLng([focus.lat, focus.lon]).setContent(html).openOn(map);

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

      const marker = L.circleMarker([lat, lon], { ...DOT, radius: 5 + Math.min(list.length, 6), fillColor: COLORS.airport })
        .bindTooltip(`${esc(code)} · ${count(list.length)}`, { direction: "top" })
        .bindPopup(popup, { className: "spy-popup" })
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
