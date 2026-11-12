// UND sounding uploader (src/pages/und.astro), talking to server/und.py. The page sends the GRAW or iMet
// file; the server reads it with SounderPy, draws and archives the plot, and publishes it to the map wall.
// The login is a cookie this script can't read; every request just carries it.

// `npm run dev` talks to a local API (uvicorn api:app --port 8000); builds use the droplet.
const API = (import.meta.env.PUBLIC_SOUNDERPY_API
  ?? (import.meta.env.DEV ? "http://localhost:8000" : "https://api.sounderpy.app")).replace(/\/$/, "") + "/api/und";

import { createViewer } from "./image-viewer.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const num = (v) => (v === "" || v == null ? null : Number(v));
const form = $('[data-source="und"]');
const settingsEl = $("#settings");
const settingsForm = $(".spy-settings-form");
const field = (name) => settingsForm.elements.namedItem(name);

// ---- Time: "Now" and "minutes ago" fill the date and time boxes in UTC ----------------------

const pad = (n) => String(n).padStart(2, "0");
function setTime(date) {
  form.date.value = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  form.time.value = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
  form.date.dispatchEvent(new Event("input", { bubbles: true })); // updates the date summary (once its listener is set up)
}
// Typed or set by hand: the note stops claiming it came from the file.
function timeSetByHand(how) {
  const note = $("[data-time-note]", form);
  note.textContent = how;
  note.classList.remove("is-warn");
  note.closest("details").querySelector(".und-section-value").classList.remove("is-warn");
}
$("[data-now]", form).addEventListener("click", () => {
  setTime(new Date());
  form.minutes_ago.value = "";
  timeSetByHand("Set to now.");
});
form.minutes_ago.addEventListener("change", () => {
  const minutes = num(form.minutes_ago.value);
  if (minutes === null) return;
  setTime(new Date(Date.now() - minutes * 60_000));
  timeSetByHand(`Set to ${minutes} minutes ago.`);
});
for (const name of ["time", "date"]) {
  form[name].addEventListener("input", (e) => {
    if (!e.isTrusted) return; // setTime's own update of the date, not someone typing
    form.minutes_ago.value = "";
    timeSetByHand("Entered by hand.");
  });
}
setTime(new Date());

// "23", "23Z", "2315", "23:15" -> "23:15"; anything else -> null.
function parseTime(value) {
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*z?$/i.exec(String(value).trim());
  return m && Number(m[1]) <= 23 && Number(m[2] ?? 0) <= 59 ? `${pad(m[1])}:${m[2] ?? "00"}` : null;
}

// ---- Map: centred on Grand Forks, with the launch site pinned ---------------------------------

const GRAND_FORKS = [47.91, -97.03];
const VIEW_CENTER = [47.98, -97.1]; // at zoom 7.5 in the 520 px map: Altona, MB down to Fargo, ND
// Smaller regional towns that aren't in places.json (Natural Earth only has the larger ones here).
// Positions are approximate, for map labels only.
const REGION_TOWNS = [
  ["Grafton", 48.41, -97.41], ["Cavalier", 48.79, -97.62], ["Langdon", 48.76, -98.37],
  ["Pembina", 48.97, -97.24], ["Northwood", 47.73, -97.57], ["Mayville", 47.50, -97.32],
  ["Hillsboro", 47.40, -97.06], ["Cooperstown", 47.44, -98.12], ["Valley City", 46.92, -98.00],
  ["Thief River Falls", 48.12, -96.18], ["Warren", 48.20, -96.77], ["Hallock", 48.77, -96.95], ["Red Lake Falls", 47.88, -96.27],
  ["Ada", 47.30, -96.52], ["Mahnomen", 47.32, -95.97], ["Fosston", 47.58, -95.75], ["Roseau", 48.85, -95.76],
  ["Detroit Lakes", 46.82, -95.85], ["Altona", 49.10, -97.56], ["Winkler", 49.18, -97.94],
  ["Carman", 49.50, -98.00], ["Morris", 49.35, -97.37], ["Portage la Prairie", 49.97, -98.29],
  ["Larimore", 47.91, -97.63], ["Drayton", 48.57, -97.18],
  ["Lakota", 48.04, -98.34], ["Oslo", 48.19, -97.13],
];
const ROAD_STYLE = (major) => (major
  ? { color: "#d08a5c", weight: 2, opacity: 0.9 }
  : { color: "#b88a66", weight: 1.2, opacity: 0.75 });

// Drawn the first time the form shows, since Leaflet can't measure a hidden map.
let mapStarted = false;
async function initMap() {
  if (mapStarted) return;
  mapStarted = true;
  const el = $(".spy-map", form);
  try {
    const [{ createBaseMap, pointPicker, fetchData }, { default: L }] = await Promise.all([import("./station-map.js"), import("leaflet")]);
    const map = createBaseMap(el, { center: VIEW_CENTER, zoom: 8 });
    map.options.zoomSnap = 0.25; // quarter steps, so the Altona-Fargo view fits snugly
    map.setView(VIEW_CENTER, 7.5, { animate: false });
    // Regional layers from scripts/build-station-data.mjs, above the land and below the state and country borders:
    // county lines first, then US, state, and provincial highways over them. A missing file just leaves it out.
    const overlay = (file, pane, style) => {
      map.createPane(pane).style.zIndex = 201;
      fetchData(file).then((shape) => {
        L.geoJSON(shape, { pane, style, interactive: false, renderer: L.canvas({ pane, padding: 0.5 }) }).addTo(map);
      }).catch((err) => console.error(`${file} failed to load`, err));
    };
    overlay("und-counties.json", "und-counties", { color: "#433d31", weight: 0.8, opacity: 0.9 });
    overlay("und-roads.json", "und-roads", (f) => ROAD_STYLE(f.properties.major));
    map.createPane("und-towns").style.zIndex = 350; // with the basemap's own town labels, below the pin
    for (const [name, lat, lon] of REGION_TOWNS) {
      L.marker([lat, lon], {
        pane: "und-towns", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "spy-place", html: `<span>${name}</span>`, iconSize: null }),
      }).addTo(map);
    }
    const picker = pointPicker(map, { onPick: (lat, lon) => { form.lat.value = lat; form.lon.value = lon; updateSummaries(); markStale(); } });
    const follow = () => {
      const lat = num(form.lat.value), lon = num(form.lon.value);
      if (Number.isFinite(lat) && Number.isFinite(lon)) picker.set(lat, lon, { pan: true });
    };
    picker.set(...GRAND_FORKS);
    movePin = follow;
    form.lat.addEventListener("change", follow);
    form.lon.addEventListener("change", follow);
  } catch (err) {
    console.error(err);
    el.textContent = "The map could not be loaded. You can still type values below.";
    el.classList.add("is-error");
  }
}

// ---- File: GRAW, iMet, or Windsond, read by the server -------------------------------------------

const fileName = $(".spy-upload-name", form);
const FILE_PROMPT = fileName.textContent;
// Full 1-second launch files run 1–3 MB (a whole iMet flight is about 1.7 MB). The UND endpoint will
// allow 5 MB, above the public upload tab's 1 MB, since only the logged-in ops account can use it.
const MAX_FILE_BYTES = 5 * 1024 ** 2;
const FORMAT_NAMES = { graw: "GRAW", imet: "iMet", windsond: "Windsond" };
const fileSummary = $(".spy-upload-summary", form);
const timeNote = $("[data-time-note]", form);
const TIME_NOTE = timeNote.textContent;

form.file.addEventListener("change", async () => {
  const file = form.file.files[0];
  fileName.classList.remove("is-error");
  fileSummary.textContent = "";
  fileSummary.classList.remove("is-error");
  if (file && file.size > MAX_FILE_BYTES) {
    form.file.value = "";
    fileName.textContent = `${file.name} is ${(file.size / 1024 ** 2).toFixed(1)} MB. The limit is 5 MB.`;
    fileName.classList.add("is-error");
    return;
  }
  if (!file) {
    fileName.textContent = FILE_PROMPT;
    return;
  }
  const text = await file.text();
  const format = fileFormat(file.name, text);
  if (form.file.files[0] !== file) return; // another file was chosen meanwhile
  if (!format) {
    fileName.textContent = `${file.name} · not a GRAW, iMet, or Windsond file?`;
    fileName.classList.add("is-error");
    return;
  }
  fileName.textContent = `${file.name} · ${FORMAT_NAMES[format]} file`;
  fileSummary.textContent = "Reading…";
  try {
    const read = await call("/read", { method: "POST", body: { format, filename: file.name, text, elevation: num(form.elevation.value) } });
    if (form.file.files[0] !== file) return;
    showFileRead(read);
  } catch (err) {
    if (form.file.files[0] !== file) return;
    fileSummary.textContent = err.message;
    fileSummary.classList.add("is-error");
  }
});

// What's in the file, its launch time in the time boxes, and a note if its location is far from the site.
function showFileRead(read) {
  const parts = [`${read.levels.toLocaleString()} levels to ${read.top.pressure} hPa (${km(read.top.height)})`];
  if (read.gaps.length) parts.push(`data gap${read.gaps.length > 1 ? "s" : ""} ${read.gaps.map(([b, t]) => `${b}–${t} hPa`).join(", ")}`);
  if (read.surface_wind_missing) parts.push("no surface wind");
  fileSummary.textContent = parts.join(" · ");
  fileSummary.classList.toggle("is-warn", read.gaps.length > 0 || read.surface_wind_missing);

  timeNote.classList.remove("is-warn");
  timeSummary.classList.remove("is-warn");
  if (read.launch_time) {
    setTime(new Date(read.launch_time));
    form.minutes_ago.value = "";
    timeNote.textContent = read.date_guessed
      ? `Time from the file. GRAW files don't hold the date and this file's name doesn't start with one, so the date is a guess: check it.`
      : `From the file: launched ${read.launch_time.slice(0, 10)} at ${read.launch_time.slice(11, 19)} UTC.`;
    timeNote.classList.toggle("is-warn", read.date_guessed);
    timeSummary.classList.toggle("is-warn", read.date_guessed);
    if (read.date_guessed) timeSection.open = true;
  } else {
    timeNote.textContent = "The file has no launch time. Enter it, or use Now or Minutes ago.";
    timeNote.classList.add("is-warn");
    timeSummary.classList.add("is-warn");
    timeSection.open = true;
  }

  siteNote.hidden = true;
  const [fileLat, fileLon] = read.file_latlon ?? [];
  if (fileLat != null && distanceKm(fileLat, fileLon, num(form.lat.value), num(form.lon.value)) > 20) {
    siteNote.replaceChildren(`The file says it was launched at ${fileLat}, ${fileLon}, more than 20 km from this site. `,
      Object.assign(document.createElement("button"), {
        type: "button", className: "und-summary-action", textContent: "Use the file's location",
        onclick: () => { setSite(fileLat, fileLon); siteNote.hidden = true; },
      }));
    siteNote.hidden = false;
    siteSection.open = true;
  }
}

// ---- Collapsed sections: launch site and plot title -------------------------------------------

const siteSection = $("[data-site-section]", form);
const timeSection = $("[data-time-section]", form);
const timeSummary = $("[data-time-summary]", form);
const siteNote = $("[data-site-note]", form);
const siteSummary = $("[data-site-summary]", form);
const titleSummary = $("[data-title-summary]", form);

function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

function updateSummaries() {
  const day = form.date.value ? new Date(`${form.date.value}T00:00:00Z`) : null;
  const dayText = day && !isNaN(day)
    ? day.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" })
    : "No date";
  const hhmm = parseTime(form.time.value);
  timeSummary.textContent = `${dayText} · ${hhmm ? `${hhmm} UTC` : "no time"}`;
  const place = form.location.value.trim();
  siteSummary.textContent = [place || "No location name", `${form.lat.value || "?"}, ${form.lon.value || "?"}`].join(" · ");
  titleSummary.textContent = form.title.value.trim() || "No title";
}

let movePin = () => {}; // set once the map is ready
function setSite(lat, lon) {
  form.lat.value = lat;
  form.lon.value = lon;
  movePin();
  updateSummaries();
  markStale();
}

form.addEventListener("input", updateSummaries);
updateSummaries();

for (const [type, over] of [["dragenter", true], ["dragleave", false], ["drop", false]]) {
  form.file.addEventListener(type, () => form.file.parentElement.classList.toggle("is-over", over));
}

// ---- Figure settings -----------------------------------------------------------------------

function readSettings() {
  const sfc = {};
  for (const key of ["T", "Td", "ws", "wd"]) {
    const v = num(field(`sfc_${key}`).value);
    if (v !== null) sfc[key] = v;
  }
  if (Object.keys(sfc).length && field("sfc_method").value !== "mix") {
    sfc.method = field("sfc_method").value;
    if (sfc.method === "blend" && num(field("sfc_depth").value) !== null) sfc.depth = num(field("sfc_depth").value);
  }
  return {
    winter: field("winter").checked,
    color_blind: field("color_blind").checked,
    ylim_top: num(field("ylim_top").value),
    map_zoom: Math.min(num(field("map_zoom").value) ?? 0, 4),
    radar: field("radar").value || null,
    radar_time: field("radar_when").value === "custom" ? field("radar_time").value || null : null,
    modify_sfc: Object.keys(sfc).length ? sfc : null,
  };
}

// How many settings differ from UND's defaults, shown on the "Customize figure" button.
function changedCount() {
  let n = 0;
  for (const el of settingsForm.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") n += el.checked !== el.defaultChecked;
    else if (el.tagName === "SELECT") n += el.value !== ([...el.options].find((o) => o.defaultSelected) ?? el.options[0]).value;
    else n += el.value !== el.defaultValue;
  }
  return n;
}

function updateSettings() {
  settingsForm.querySelector("[data-sfc-depth]").hidden = field("sfc_method").value !== "blend";
  settingsForm.querySelector("[data-radar-custom]").hidden = field("radar_when").value !== "custom";
  settingsForm.querySelector("[data-map-toggle]").checked = (num(field("map_zoom").value) ?? 0) > 0;
  const n = changedCount();
  for (const badge of $$(".spy-settings-count")) {
    badge.textContent = `${n} change${n === 1 ? "" : "s"}`;
    badge.hidden = n === 0;
  }
}

settingsForm.addEventListener("submit", (e) => e.preventDefault());
$$("[data-open-settings]").forEach((b) => b.addEventListener("click", () => settingsEl.showModal()));
$$("[data-close-settings]").forEach((b) => b.addEventListener("click", () => settingsEl.close()));
settingsEl.addEventListener("click", (e) => { if (e.target === settingsEl) settingsEl.close(); }); // backdrop
// Show map on starts at zoom 1; off sets zoom 0. Choosing radar turns the map back on.
settingsForm.querySelector("[data-map-toggle]").addEventListener("input", (e) => {
  if (e.target.checked && !(num(field("map_zoom").value) > 0)) field("map_zoom").value = "1";
  if (!e.target.checked) field("map_zoom").value = "0";
});
field("radar").addEventListener("change", (e) => {
  if (e.target.value && num(field("map_zoom").value) === 0) field("map_zoom").value = "1";
});
settingsForm.addEventListener("input", updateSettings);
settingsForm.addEventListener("change", updateSettings);
$("[data-settings-reset]").addEventListener("click", () => { settingsForm.reset(); updateSettings(); });
updateSettings();

// ---- Talking to the server ---------------------------------------------------------------

const health = $(".spy-health");
const healthText = $(".spy-health-text");
const loginForm = $("[data-login]");
const loginError = $(".und-login-error");
const app = $("[data-und-app]");
const logoutButton = $("[data-logout]");

function setHealth(state, text) {
  health.dataset.state = state;
  healthText.textContent = text;
}

// JSON from the UND API. A 401 means the login ran out, so the sign-in box comes back.
async function call(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      credentials: "include",
      ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
  } catch {
    setHealth("offline", "Can't reach the sounding server");
    throw new Error("Couldn't reach the sounding server. Check your connection, or try again in a moment.");
  }
  setHealth("online", "Sounding server online");
  if (res.status === 401 && path !== "/login") showLogin();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.detail) ? data.detail.map((d) => d.msg).join("; ") : data.detail;
    throw new Error(detail || `Server error (${res.status})`);
  }
  return data;
}

function showLogin() {
  app.hidden = true;
  logoutButton.hidden = true;
  loginForm.hidden = false;
  loginForm.password.focus();
}

function showApp() {
  loginForm.hidden = true;
  loginError.textContent = "";
  loginForm.password.value = "";
  app.hidden = false;
  logoutButton.hidden = false;
  initMap();
  loadLaunches();
}

async function checkSession() {
  try {
    const session = await call("/session");
    session.signed_in ? showApp() : showLogin();
  } catch (err) {
    // 503: the server is up, but the UND uploader isn't configured there.
    setHealth("offline", err.message);
  }
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = $("button", loginForm);
  button.disabled = true;
  loginError.textContent = "";
  try {
    await call("/login", { method: "POST", body: { password: loginForm.password.value } });
    showApp();
  } catch (err) {
    loginError.textContent = err.message;
    loginForm.password.select();
  } finally {
    button.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  await call("/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// ---- Step 1, Plot: send the file; the server reads, draws, and saves it ------------------------
// The server keeps the plot under a random ID. Publish sends only that ID, so the map wall always
// gets exactly the figure shown here.

const statusTop = $("[data-status]");
const result = $(".und-result");
const caption = $(".spy-caption", result);
const plotImage = $(".spy-image-link img", result);
const summaryList = $("[data-summary]");
const plotButton = $(".spy-submit", form);
const publishButton = $("[data-publish]");
const publishNote = $("[data-publish-note]");
const publishState = $("[data-publish-state]");
let plotted = null; // the launch record on screen; null once anything in the form changes
let shown = null; // the launch record whose plot is on screen, even after it's published or goes stale

function setStatus(message, error = false) {
  statusTop.textContent = message;
  statusTop.classList.toggle("is-error", error);
}

function setPublish(state, detail = "") {
  publishButton.disabled = !["ready", "failed"].includes(state) || !plotted;
  $("span", publishButton).textContent = state === "failed" ? "3 · Retry publish" : "3 · Publish to map wall";
  publishNote.classList.toggle("is-done", state === "published");
  publishNote.classList.toggle("is-error", state === "failed");
  publishNote.textContent = {
    none: "Plot first, then check the figure before publishing.",
    stale: "Something changed since the last plot. Plot again before publishing.",
    ready: "Check the figure and the summary below. Publishing sends it to the UND map wall.",
    sending: "Sending to the map wall…",
    published: "Published to the map wall.",
    failed: `Not published: ${detail}`,
  }[state];
  publishState.textContent = state === "published" ? "Published" : state === "failed" ? "Publish failed" : "Not published";
}

// Any change after a plot means the figure on screen no longer matches the form.
function markStale() {
  if (!plotted) return;
  plotted = null;
  setPublish("stale");
}
form.addEventListener("input", markStale);
form.addEventListener("change", markStale);
settingsForm.addEventListener("change", markStale);

// GRAW exports are tab-separated with a "Time (UTC)" column; iMet (SkySonde) files start with station meta-data;
// Windsond files have a "# ... utc_time=" comment and a "Height (m AGL)" column.
function fileFormat(name, text) {
  const head = text.slice(0, 4000);
  if (/time \(utc\)/i.test(head.split("\n")[0]) && head.includes("\t")) return "graw";
  if (/skysonde|imet/i.test(head)) return "imet";
  if (/utc_time=|^height \(m agl\)/im.test(head)) return "windsond";
  if (/\.csv$/i.test(name)) return "imet";
  if (/\.txt$/i.test(name)) return "graw";
  return null;
}

const fmtTime = ([y, m, d, h] = []) => (y ? `${y}-${pad(m)}-${pad(d)} ${pad(h)}Z` : "");
const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

// What the server read, plus anything that disagrees with the form, before anyone publishes.
function showSummary(record, request) {
  const s = record.summary;
  const items = [
    [`Read ${s.levels.toLocaleString()} levels (${record.levels.plotted} plotted)`],
    [`Surface ${s.surface.pressure} hPa, ${km(s.surface.height)}`],
    [`Top ${s.top.pressure} hPa, ${km(s.top.height)}`],
  ];
  // The file's launch time ('2026-01-25T20:26:35Z') against the one entered, to the minute.
  let useFileTime = null;
  if (s.launch_time) {
    const launch = new Date(s.launch_time);
    const fileDate = s.launch_time.slice(0, 10), fileHHMM = s.launch_time.slice(11, 16);
    items.push([`File launch time ${fileDate} ${fileHHMM}:${s.launch_time.slice(17, 19)}Z`]);
    if (fileDate !== request.date || fileHHMM !== request.time) {
      items.push([`The file says the launch was ${fileDate} ${fileHHMM}Z, not ${request.date} ${request.time}Z as entered`, "warn"]);
      useFileTime = () => { setTime(launch); markStale(); setStatus("Time set from the file. Plot again to update the figure."); };
    }
  } else if (s.valid_time) {
    items.push([`File launch hour ${fmtTime(s.valid_time)}`]);
  } else {
    items.push(["The file has no launch time, so the time entered is used", "warn"]);
  }
  if (s.file_latlon && (Math.abs(s.file_latlon[0] - request.lat) > 0.2 || Math.abs(s.file_latlon[1] - request.lon) > 0.2)) {
    items.push([`The file's location (${s.file_latlon.join(", ")}) is far from the one entered`, "warn"]);
  }
  if (s.surface_wind_missing) items.push(["No surface wind in the file, so 10 m wind shows as NA", "warn"]);
  for (const [bottom, top] of s.gaps) items.push([`Data gap from ${bottom} to ${top} hPa`, "warn"]);
  for (const note of record.notes ?? []) items.push([note, "warn"]);
  summaryList.replaceChildren(...items.map(([text, kind]) => {
    const li = document.createElement("li");
    li.textContent = text;
    if (kind) li.className = "is-warn";
    return li;
  }));
  if (useFileTime) {
    const button = Object.assign(document.createElement("button"), { type: "button", className: "und-summary-action", textContent: "Use the file's time" });
    button.addEventListener("click", useFileTime);
    summaryList.append(Object.assign(document.createElement("li"), { className: "is-action" }));
    summaryList.lastChild.append(button);
  }
  summaryList.hidden = false;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = form.file.files[0];
  const time = parseTime(form.time.value);
  if (!file) return setStatus("Choose the launch file first.", true);
  if (!time || !form.date.value) {
    timeSection.open = true;
    return setStatus(time ? "Choose the launch date." : "Enter a UTC time from 0000 to 2359, e.g. 2315.", true);
  }
  const text = await file.text();
  const format = fileFormat(file.name, text);
  if (!format) return setStatus("This doesn't look like a GRAW, iMet, or Windsond file.", true);
  const lat = num(form.lat.value), lon = num(form.lon.value);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {
    siteSection.open = true;
    return setStatus("Check the launch site's latitude and longitude.", true);
  }
  if (format === "windsond" && num(form.elevation.value) === null) {
    siteSection.open = true;
    return setStatus("Enter the launch site's elevation in meters. Windsond files don't include it.", true);
  }

  const request = {
    format,
    filename: file.name,
    text,
    date: form.date.value,
    time,
    lat: num(form.lat.value),
    lon: num(form.lon.value),
    elevation: format === "windsond" ? num(form.elevation.value) : null,
    title: form.title.value,
    location: form.location.value,
    settings: readSettings(),
  };
  plotButton.disabled = true;
  publishButton.disabled = true;
  setStatus("");
  startLoading(request, file);
  try {
    const record = await call("/plot", { method: "POST", body: request });
    plotted = shown = record;
    setStatus("");
    caption.hidden = false;
    $(".spy-title", result).textContent = record.title || "UND Observed Vertical Profile";
    $(".spy-meta", result).replaceChildren(...[`${record.date} ${record.time} UTC`, record.location, `${record.lat}, ${record.lon}`, record.filename]
      .filter(Boolean).map((t) => Object.assign(document.createElement("span"), { textContent: t })));
    plotImage.src = record.image;
    plotImage.alt = `Sounding plot: ${record.title}, ${record.date} ${record.time} UTC`;
    showSummary(record, request);
    setPublish("ready");
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    stopLoading();
    plotButton.disabled = false;
  }
});

// ---- "Building your sounding" card, with a timer -----------------------------------------------

let timer = null;
function startLoading(req, file) {
  const started = Date.now();
  const elapsed = $(".spy-elapsed", result);
  const hint = $(".spy-loading-hint", result);
  const sizeMB = (file.size / 1024 ** 2).toFixed(1);
  $(".spy-loading-request", result).textContent =
    `${FORMAT_NAMES[req.format]} launch · ${req.date} ${req.time}Z · ${req.location || `${req.lat}, ${req.lon}`}\n${file.name} (${sizeMB} MB)`;
  const s = req.settings;
  const chips = [
    s.winter && "Winter sounding",
    s.color_blind && "Color-blind friendly",
    s.ylim_top && "Surface to 500 hPa",
    s.map_zoom > 0 && `Map zoom ${s.map_zoom}`,
    s.radar && (s.radar === "mosaic" ? "MRMS radar" : "NEXRAD radar"),
    s.radar_time && `Radar ${s.radar_time.replace("T", " ")}Z`,
    s.modify_sfc && "Surface values changed",
  ].filter(Boolean);
  $(".spy-loading-settings", result).replaceChildren(...chips.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
  hint.textContent = s.radar ? "Radar maps add time; usually under 30 seconds." : "Usually 5–15 seconds.";
  elapsed.textContent = "0:00";
  result.dataset.state = "loading";
  result.setAttribute("aria-busy", "true");
  result.scrollIntoView({ behavior: "smooth", block: "start" });
  clearInterval(timer);
  timer = setInterval(() => {
    const secs = Math.floor((Date.now() - started) / 1000);
    elapsed.textContent = `${Math.floor(secs / 60)}:${pad(secs % 60)}`;
    if (secs === 60) hint.textContent = "Still working. The radar source may be slow right now.";
  }, 1000);
}

function stopLoading() {
  clearInterval(timer);
  result.dataset.state = plotImage.getAttribute("src") ? "ready" : "empty";
  result.setAttribute("aria-busy", "false");
}

// ---- Click the plot to open it full screen: zoom, pan, copy, download ------------------------

async function copyPlot() {
  const src = plotImage.getAttribute("src");
  if (!src || !window.ClipboardItem || !navigator.clipboard?.write) return false;
  try {
    const png = fetch(src).then((r) => r.blob()).then((b) => new Blob([b], { type: "image/png" }));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}

const viewer = createViewer($(".spy-viewer"), {
  onCopy: async (label) => {
    label.textContent = (await copyPlot()) ? "Copied!" : "Use PNG";
    setTimeout(() => { label.textContent = "Copy"; }, 2500);
  },
});
$(".spy-image-link", result).addEventListener("click", () => {
  const src = plotImage.getAttribute("src");
  if (!src) return;
  $(".spy-viewer-download").download = shown
    ? `und_sounding_${shown.date.replaceAll("-", "")}_${shown.time.replace(":", "")}.png` : "und_sounding.png";
  const meta = [...$(".spy-meta", result).children].map((span) => span.textContent);
  viewer.open(src, [$(".spy-title", result).textContent, ...meta].filter(Boolean).join("  ·  "));
});

// ---- Step 2, Publish: send the plotted figure to the map wall ----------------------------------

publishButton.addEventListener("click", async () => {
  if (!plotted) return;
  if (!confirm("Publish this sounding to the UND map wall? Students and the NWS will see it.")) return;
  setPublish("sending");
  publishButton.disabled = true;
  try {
    plotted = await call(`/launches/${plotted.id}/publish`, { method: "POST" });
    setPublish("published");
    plotted = null; // published once; plot again to send something new
  } catch (err) {
    setPublish("failed", err.message);
  }
  loadLaunches();
});

// ---- Past launches -------------------------------------------------------------------------

const launchList = $("[data-launches]");
const launchesEmpty = $("[data-launches-empty]");
const STATUS_TEXT = { published: "Published", failed: "Publish failed", retracted: "Removed from the wall", sending: "Sending…" };
const when = (iso) => (iso ? new Date(iso).toISOString().slice(11, 16) + " UTC" : "");

async function loadLaunches() {
  let launches;
  try {
    launches = await call("/launches?limit=50");
  } catch {
    return; // a sign-in prompt or the status bar already says why
  }
  launchesEmpty.hidden = launches.length > 0;
  launchList.replaceChildren(...launches.map((l) => {
    const li = document.createElement("li");
    const text = document.createElement("div");
    text.className = "und-launch-text";
    const status = l.status === "published" ? `Published ${when(l.published)}`
      : l.status === "failed" ? `Publish failed: ${l.history.at(-1)?.error ?? ""}` : STATUS_TEXT[l.status] ?? l.status;
    text.append(
      Object.assign(document.createElement("strong"), { textContent: `${l.date} · ${l.time} UTC` }),
      Object.assign(document.createElement("span"), { textContent: [l.title, l.location].filter(Boolean).join(" · ") }),
      Object.assign(document.createElement("small"), { textContent: status, className: `is-${l.status}` }),
    );
    const actions = document.createElement("div");
    actions.className = "und-launch-actions";
    const link = (label, href) => Object.assign(document.createElement("a"), { className: "spy-secondary", textContent: label, href, target: "_blank", rel: "noopener" });
    actions.append(link("View plot", `${API}/launches/${l.id}/plot.png`), link("Raw file", `${API}/launches/${l.id}/raw`));
    if (l.status === "published") {
      const remove = Object.assign(document.createElement("button"), { type: "button", className: "spy-secondary", textContent: "Remove from wall" });
      remove.addEventListener("click", async () => {
        if (!confirm(`Remove the ${l.date} ${l.time} UTC sounding from the map wall?`)) return;
        remove.disabled = true;
        try {
          await call(`/launches/${l.id}/retract`, { method: "POST" });
        } catch (err) {
          alert(err.message);
        }
        loadLaunches();
      });
      actions.append(remove);
    }
    li.append(text, actions);
    return li;
  }));
}

checkSession();

// ---- UTC clock in the status bar -------------------------------------------------------------

const clock = $(".spy-utc");
const utc = (d, opts) => d.toLocaleString("en-US", { timeZone: "UTC", ...opts });
function tickClock() {
  const now = new Date();
  clock.dateTime = now.toISOString();
  clock.textContent = `${utc(now, { weekday: "short", month: "short", day: "numeric" })} · ${utc(now, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })} UTC`;
}
tickClock();
setInterval(tickClock, 1000);
