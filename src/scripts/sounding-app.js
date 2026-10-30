// Behaviour for the sounding-analysis pages. Expects the markup from
// src/components/sounding/* inside an element with class "spy".

import { createViewer } from "./image-viewer.js";

// `npm run dev` talks to a local API (uvicorn api:app --port 8000); builds use the droplet.
const API = (import.meta.env.PUBLIC_SOUNDERPY_API
  ?? (import.meta.env.DEV ? "http://localhost:8000" : "https://api.sounderpy.app")).replace(/\/$/, "");

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const status = $(".spy-status");
const result = $(".spy-result");
const settingsEl = $("#settings");
let lastRequest = null;
let lastShareUrl = null; // address of the sounding on screen, with the settings it was made with

// ---- API ------------------------------------------------------------------

async function api(path, body) {
  const res = await fetch(API + path, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = Array.isArray(err.detail) ? err.detail.map((d) => d.msg).join("; ") : err.detail;
    throw new Error(detail || `Server error (${res.status})`);
  }
  return res;
}

function setBusy(busy, message = "") {
  $$(".spy-panel .spy-submit, [data-action], [data-download]").forEach((el) => el.toggleAttribute("disabled", busy));
  status.textContent = message;
  status.classList.remove("is-error");
}

// Errors open a popup with a title saying what failed and a message saying what to do.
const dialog = $(".spy-dialog");
dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); }); // click the backdrop to close

function showError(err, title = "Something went wrong") {
  setBusy(false);
  const message = err instanceof TypeError
    ? "Couldn't reach the sounding server. Check your connection, or try again in a moment."
    : err.message;
  if (typeof dialog.showModal !== "function") {
    status.textContent = message;
    status.classList.add("is-error");
    return;
  }
  $("#spy-dialog-title").textContent = title;
  $("#spy-dialog-message").textContent = message;
  if (!dialog.open) dialog.showModal();
}

// ---- Form values ------------------------------------------------------------

const num = (v) => (v === "" || v == null ? null : Number(v));

function readSettings() {
  const f = (name) => settingsEl.querySelector(`[name="${name}"]`);
  const smDir = num(f("sm_dir").value), smSpd = num(f("sm_spd").value);
  const sfc = {};
  for (const key of ["T", "Td", "ws", "wd"]) {
    const v = num(f(`sfc_${key}`).value);
    if (v !== null) sfc[key] = v;
  }
  return {
    dark_mode: f("dark_mode").checked,
    color_blind: f("color_blind").checked,
    ecape: f("ecape").checked,
    hodo: f("hodo").checked,
    hodo_boundary_angle: num(f("hodo_boundary_angle").value),
    map_zoom: num(f("map_zoom").value) ?? 0,
    radar: f("radar").value || null,
    radar_time: f("radar_time").value || null,
    storm_motion: smDir !== null && smSpd !== null ? [smDir, smSpd] : f("storm_motion").value,
    modify_sfc: Object.keys(sfc).length ? sfc : null,
  };
}

// "7", "07", "07Z", "0700", "07:00" -> "07"; anything else -> null.
const HOUR_MESSAGE = "Enter a UTC hour from 0 to 23, e.g. 12 or 00.";
function parseHour(value) {
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*z?$/i.exec(String(value).trim());
  return m && Number(m[1]) <= 23 ? m[1].padStart(2, "0") : null;
}

function buildRequest(form) {
  const data = Object.fromEntries(new FormData(form));
  const req = { source: form.dataset.source, settings: readSettings() };

  if (req.source === "acars") {
    if (!data.profile) throw new Error("Find flights and choose a profile first.");
    const picked = JSON.parse(data.profile);
    Object.assign(req, { profile: picked.id, hour: picked.hour, date: data.date });
  } else if (req.source === "reanalysis") {
    const [lat, lon] = data.coords.split(",").map((v) => Number(v.trim()));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Enter coordinates as \"lat, lon\".");
    Object.assign(req, { lat, lon, date: data.date, hour: parseHour(data.hour) });
  } else {
    for (const [k, v] of Object.entries(data)) {
      if (v !== "") req[k] = k === "fcst_hr" ? Number(v) : k === "hour" ? parseHour(v) : v;
    }
  }
  return req;
}

// ---- Result frame -------------------------------------------------------------

const SOURCE_NAMES = {
  raob: "Observed radiosonde · RAOB",
  acars: "Aircraft profile · ACARS",
  bufkit: "Model forecast · BUFKIT",
  reanalysis: "Model reanalysis · RAP-RUC",
};
const pad2 = (v) => String(v).padStart(2, "0");
const titleCase = (s) => (s && s === s.toUpperCase() && s.length > 3
  ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s);
const coords = (lat, lon) =>
  `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
const utc = (iso, opts) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(new Date(iso));

function describeRequest(req) {
  const when = req.date ? `${req.date} ${pad2(req.hour)}Z` : "";
  const parts = {
    raob: ["RAOB", req.site?.toUpperCase(), when],
    acars: ["ACARS", req.profile, when],
    bufkit: [req.model?.toUpperCase(), req.site?.toUpperCase(), `F${pad2(req.fcst_hr)}`, req.hour ? `run ${when}` : "latest run"],
    reanalysis: ["RAP-RUC", req.lat != null ? coords(req.lat, req.lon) : "", when],
  }[req.source];
  if (req.settings.hodo) parts.push("hodograph");
  return parts.filter(Boolean).join("  ·  ");
}

// Only the settings the user changed from their defaults.
function settingsSummary(s) {
  const sm = Array.isArray(s.storm_motion)
    ? `${s.storm_motion[0]}° at ${s.storm_motion[1]} kt`
    : { left_moving: "left mover", mean_wind: "mean wind" }[s.storm_motion];
  const sfc = s.modify_sfc && Object.entries(s.modify_sfc)
    .map(([k, v]) => `${k} ${v}${{ T: "°C", Td: "°C", ws: " kt", wd: "°" }[k]}`).join(", ");
  return [
    s.dark_mode && "Dark mode",
    !s.color_blind && "Standard colors (color-blind mode off)",
    s.ecape && "ECAPE parcel path",
    s.hodo && "Hodograph only",
    s.hodo_boundary_angle != null && `Boundary axis at ${s.hodo_boundary_angle}°`,
    s.map_zoom !== 0 && `Map zoom ${s.map_zoom}`,
    s.radar && `Radar: ${{ "single-site": "NEXRAD site", mosaic: "MRMS mosaic" }[s.radar]}${s.radar_time ? ` at ${s.radar_time.replace("T", " ")} UTC` : ""}`,
    sm && `Storm motion: ${sm}`,
    sfc && `Surface modified: ${sfc}`,
  ].filter(Boolean);
}

function loadingHint(req) {
  if (req.source === "reanalysis") return "Reanalysis data can take a minute or more.";
  if (req.settings.ecape || req.settings.radar) return "ECAPE and radar maps add extra time.";
  return "Usually 5–30 seconds.";
}

let timer = null;
function startLoading(req) {
  const started = Date.now();
  const elapsed = $(".spy-elapsed");
  const hint = $(".spy-loading-hint");
  $(".spy-loading-request").textContent = describeRequest(req);
  $(".spy-loading-settings").replaceChildren(...settingsSummary(req.settings).map((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    return li;
  }));
  hint.textContent = loadingHint(req);
  elapsed.textContent = "0:00";
  result.dataset.state = "loading";
  result.setAttribute("aria-busy", "true");
  clearInterval(timer);
  timer = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    elapsed.textContent = `${Math.floor(s / 60)}:${pad2(s % 60)}`;
    if (s === 60) hint.textContent = "Still working. The data source may be slow right now.";
  }, 1000);
}

function stopLoading() {
  clearInterval(timer);
  result.dataset.state = $("img", result).getAttribute("src") ? "ready" : "empty";
  result.setAttribute("aria-busy", "false");
}

function renderCaption(req, label, info) {
  const caption = $(".spy-caption");
  const meta = $(".spy-meta");
  meta.replaceChildren();
  const row = (term, value) => {
    if (!value) return;
    const item = document.createElement("span"), key = document.createElement("b");
    key.textContent = term;
    item.append(key, ` ${value}`);
    meta.append(item);
  };

  if (!info) {
    $(".spy-kicker").textContent = SOURCE_NAMES[req.source];
    $(".spy-title").textContent = label;
    caption.hidden = false;
    return;
  }

  const place = [titleCase(info.site_name), info.location].filter(Boolean).join(", ");
  $(".spy-kicker").textContent = [
    req.source === "bufkit" && info.model ? `${info.model} model forecast · BUFKIT` : SOURCE_NAMES[req.source],
    req.settings.hodo ? "Hodograph" : "",
  ].filter(Boolean).join("  ·  ");
  $(".spy-title").textContent = req.source === "reanalysis"
    ? coords(info.lat, info.lon)
    : [info.site_id, place].filter(Boolean).join("  ·  ");

  if (info.valid_time) row("Valid", `${utc(info.valid_time, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} UTC ${utc(info.valid_time, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}`);
  if (info.run_time) row("Run", `${utc(info.run_time, { hour: "2-digit", hourCycle: "h23" })}Z ${utc(info.run_time, { month: "short", day: "numeric" })}${info.fcst_hour ? `, ${info.fcst_hour}` : ""}`);
  row("At", [req.source !== "reanalysis" && coords(info.lat, info.lon), info.elevation_m != null && `${info.elevation_m.toLocaleString()} m`].filter(Boolean).join(", "));
  caption.hidden = false;
}

// Bumped whenever the frame is cleared, so a response for an abandoned request is ignored.
let requestId = 0;

function clearResult() {
  requestId++;
  clearInterval(timer);
  lastRequest = null;
  lastShareUrl = null;
  const img = $("img", result);
  img.removeAttribute("src");
  img.alt = "";
  $('[data-download="png"]').removeAttribute("href");
  $(".spy-caption").hidden = true;
  result.dataset.state = "empty";
  result.setAttribute("aria-busy", "false");
  setBusy(false);
}

function getSounding(form) {
  let req;
  try { req = buildRequest(form); } catch (err) { return showError(err, "Check your request"); }
  runSounding(req, { record: true });
}

// `record` adds the sounding to the address bar and browser history (see shareable links below).
async function runSounding(req, { record = false } = {}) {
  const id = ++requestId;
  const shareUrl = requestUrl(req); // captured now, so later setting changes don't alter it
  setBusy(true);
  startLoading(req);
  result.scrollIntoView({ behavior: "smooth", block: "nearest" });
  try {
    const { label, info, image } = await (await api("/api/sounding", req)).json();
    if (id !== requestId) return;
    lastRequest = req;
    renderCaption(req, label, info);
    const img = $("img", result);
    img.src = image;
    img.alt = label;
    $('[data-download="png"]').href = image;
    lastShareUrl = shareUrl;
    if (record && shareUrl !== location.pathname + location.search) history.pushState(null, "", shareUrl);
    setBusy(false);
    stopLoading();
  } catch (err) {
    if (id !== requestId) return;
    stopLoading();
    showError(err, "Couldn't get that sounding");
  }
}

// `button` (the one clicked) pulses while the file is prepared, which matters inside the
// full-screen viewer where the status line is hidden.
async function downloadFile(output, button) {
  if (!lastRequest) return;
  setBusy(true, `Preparing ${output.toUpperCase()} file…`);
  button?.classList.add("is-busy");
  try {
    const res = await api("/api/sounding", { ...lastRequest, output });
    const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `sounderpy_data.${output}`;
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
    setBusy(false);
  } catch (err) {
    showError(err, "Couldn't prepare that file");
  } finally {
    button?.classList.remove("is-busy");
  }
}

function setSearchMode(form, mode) {
  form.search.value = mode;
  for (const el of $$("[data-search]", form)) el.hidden = el.dataset.search !== mode;
}

// Step 1 of ACARS: list flights for one airport (all day) or one hour (all airports).
// `focus` is the airport clicked on the map; its popup shows the results.
async function findProfiles(form, { focus } = {}) {
  const byAirport = form.search.value === "airport";
  const date = form.date.value, airport = form.airport.value.trim().toUpperCase(), hour = parseHour(form.hour.value);
  const searchError = (message) => showError(new Error(message), "Check your flight search");
  if (!date) return searchError("Choose a flight date first.");
  if (byAirport && !airport) return searchError("Enter an airport code, or click an airport on the map.");
  if (!byAirport && !hour) return searchError(HOUR_MESSAGE);

  const params = new URLSearchParams({ date });
  byAirport ? params.set("airport", airport) : params.set("hour", hour);
  setBusy(true, byAirport ? `Searching all 24 hours for ${airport}…` : `Searching ${hour}Z flights at every airport…`);
  if (focus) maps.acars?.airports?.searching(focus);

  try {
    const profiles = await (await api(`/api/acars/profiles?${params}`)).json();
    const select = form.profile;
    select.replaceChildren(new Option(
      profiles.length ? `${profiles.length} profile${profiles.length === 1 ? "" : "s"} found. Choose one…` : "No profiles found. Try another date or airport.", ""));
    for (const p of profiles) select.add(new Option(`${p.id} (${p.hour}Z) · ${p.airport}`, JSON.stringify(p)));
    maps.acars?.airports?.show(profiles, { focus });
    setBusy(false);
  } catch (err) {
    showError(err, "Couldn't find flights");
  }
}

async function loadLatestRuns() {
  try {
    const runs = await (await api("/api/bufkit/latest-runs")).json();
    const select = $('[data-source="bufkit"] [name="model"]');
    for (const run of runs) {
      const opt = [...select.options].find((o) => o.value === run.model);
      if (opt) opt.textContent = `${run.model.toUpperCase()}${run.latest_run ? ` · latest ${run.latest_run}` : ""}`;
    }
  } catch { /* model names alone are fine */ }
}

// ---- Maps (Leaflet loads on first use) ----------------------------------------

const maps = {};

async function initMap(form) {
  const source = form.dataset.source;
  if (maps[source]) return maps[source].map?.invalidateSize();
  maps[source] = {};
  const el = $(".spy-map", form);

  try {
    const { createBaseMap, fetchData, stationLayer, pointPicker, airportLayer, FAINT_DOT } = await import("./station-map.js");
    const map = maps[source].map = createBaseMap(el);

    if (source === "raob" || source === "bufkit") {
      const rows = await fetchData(`${source}-stations.json`);
      const layer = stationLayer(map, rows, { onPick: ([id]) => { form.site.value = id; } });
      layer.select(form.site.value);
      form.site.addEventListener("input", () => layer.select(form.site.value, { pan: true }));
    } else if (source === "reanalysis") {
      const picker = pointPicker(map, { onPick: (lat, lon) => { form.coords.value = `${lat}, ${lon}`; } });
      form.coords.addEventListener("change", () => {
        const [lat, lon] = form.coords.value.split(",").map(Number);
        if (Number.isFinite(lat) && Number.isFinite(lon)) picker.set(lat, lon, { pan: true });
      });
    } else if (source === "acars") {
      // Every airport as a faint dot (click to search it), then search results on top.
      // Clicking an airport searches it straight away.
      const all = stationLayer(map, await fetchData("airports.json"), {
        style: FAINT_DOT,
        popup: false,
        onPick: ([code, , , lat, lon]) => {
          setSearchMode(form, "airport");
          form.airport.value = code;
          findProfiles(form, { focus: { code, lat, lon } });
        },
      });
      form.airport.addEventListener("input", () => all.select(form.airport.value, { pan: true }));
      maps.acars.airports = airportLayer(map, {
        onPick: (p) => { form.profile.value = JSON.stringify(p); form.profile.focus(); },
      });
    }
  } catch (err) {
    console.error(err);
    el.textContent = "The map could not be loaded. You can still type values below.";
    el.classList.add("is-error");
  }
}

// Where each data source comes from (shown under the sounding).
const CREDITS = {
  raob: "Observed soundings: University of Wyoming upper-air archive (IGRA v2 from NOAA NCEI for IGRA station IDs).",
  acars: "Aircraft profiles: ACARS/AMDAR data from the University of Oklahoma SHARP archive.",
  bufkit: "Forecast soundings: Penn State BUFKIT feed, with past runs from the Iowa Environmental Mesonet archive.",
  reanalysis: "Reanalysis: RAP and RUC model analyses from NOAA NCEI.",
  composite: "Composites combine the data sources of the profiles you add.",
};

let currentTab = null;
function showTab(name, { keepUrl = false } = {}) {
  if (currentTab && currentTab !== name) clearResult();
  currentTab = name;
  $(".spy-credit").textContent = CREDITS[name];
  $$("[data-tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  $$(".spy-panel").forEach((p) => {
    p.hidden = p.dataset.source !== name;
    if (!p.hidden) initMap(p);
  });
  $("[data-composite]").hidden = name !== "composite";
  status.textContent = "";
  if (!keepUrl) history.replaceState(null, "", `${location.pathname}#${name}`);
}

// ---- Init ---------------------------------------------------------------------

const now = new Date();
const today = now.toISOString().slice(0, 10);
const utcHour = now.getUTCHours();
for (const form of $$(".spy-panel")) {
  if (form.dataset.source !== "bufkit" && !form.date.value) form.date.value = today;
}
$('[data-source="raob"] [name="hour"]').value = utcHour >= 13 || utcHour < 1 ? "12" : "00";
$('[data-source="acars"] [name="hour"]').value = String(utcHour).padStart(2, "0");

// Hour boxes that a sounding request depends on get a friendly native validation message.
// (ACARS is excluded: the picked profile carries its own hour.)
for (const input of $$('.spy-panel:not([data-source="acars"]) [name="hour"]')) {
  input.addEventListener("input", () => input.setCustomValidity(!input.value.trim() || parseHour(input.value) ? "" : HOUR_MESSAGE));
}

$$("[data-tab]").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
// A form moved into the Add profile pop-up saves a profile; otherwise it gets a sounding.
$$(".spy-panel").forEach((form) => form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (profileDialog.open) saveProfile(form);
  else getSounding(form);
}));
const acarsForm = $('[data-source="acars"]');
$('[data-action="find-profiles"]').addEventListener("click", () => findProfiles(acarsForm));
acarsForm.addEventListener("change", (e) => { if (e.target.name === "search") setSearchMode(acarsForm, e.target.value); });
// Enter in a step-1 box searches instead of submitting the (not yet ready) sounding request.
for (const name of ["airport", "hour"]) {
  acarsForm[name].addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); findProfiles(acarsForm); }
  });
}

// "Customize figure": show how many settings differ from the defaults, and allow a reset.
const settingsForm = $(".spy-settings-form");
function updateSettingsCount() {
  const n = settingsSummary(readSettings()).length;
  for (const badge of $$(".spy-settings-count")) {
    badge.textContent = `${n} change${n === 1 ? "" : "s"}`;
    badge.hidden = n === 0;
  }
}
settingsForm.addEventListener("submit", (e) => e.preventDefault());
$$("[data-open-settings]").forEach((b) => b.addEventListener("click", () => settingsEl.showModal()));
$$("[data-close-settings]").forEach((b) => b.addEventListener("click", () => settingsEl.close()));
settingsEl.addEventListener("click", (e) => { if (e.target === settingsEl) settingsEl.close(); }); // backdrop
// Radar is drawn on the map, so choosing it needs a visible map.
settingsForm.elements.namedItem("radar").addEventListener("change", (e) => {
  const zoom = settingsForm.elements.namedItem("map_zoom");
  if (e.target.value && Number(zoom.value) === 0) zoom.value = "2";
});
settingsForm.addEventListener("input", () => { updateSettingsCount(); saveSettings(); });
settingsForm.addEventListener("change", () => { updateSettingsCount(); saveSettings(); });
$("[data-settings-reset]").addEventListener("click", () => { settingsForm.reset(); updateSettingsCount(); saveSettings(); });
// Data-file buttons, both under the plot and in the viewer's toolbar.
$$("button[data-download]").forEach((b) => b.addEventListener("click", () => downloadFile(b.dataset.download, b)));

// Copy the plot itself (PNG) to the clipboard. The blob is passed as a promise, which Safari requires.
async function copyPlot() {
  const src = $("img", result).getAttribute("src");
  if (!src || !window.ClipboardItem || !navigator.clipboard?.write) return false;
  try {
    const png = fetch(src).then((r) => r.blob()).then((b) => new Blob([b], { type: "image/png" }));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}

// Briefly swap a button's label for a result, e.g. "copied!".
function flash(label, text, restore, ms = 2500) {
  label.textContent = text;
  setTimeout(() => { label.textContent = restore; }, ms);
}

$("[data-copy-image]").addEventListener("click", async (e) => {
  const note = $("small", e.currentTarget);
  flash(note, (await copyPlot()) ? "copied!" : "not supported here, use PNG", "image to clipboard");
});

// Clicking the plot opens it full screen, zoomable.
const viewer = createViewer($(".spy-viewer"), {
  onCopy: async (label) => flash(label, (await copyPlot()) ? "Copied!" : "Use PNG", "Copy"),
});
$(".spy-image-link").addEventListener("click", () => {
  const src = $("img", result).getAttribute("src");
  if (!src) return;
  const title = [$(".spy-title").textContent, $(".spy-kicker").textContent].filter(Boolean).join("  ·  ");
  viewer.open(src, title);
});

// ---- Composite tab: the profile list and Add profile pop-up -------------------------
// Front end only for now: Build composite doesn't contact the server yet.

const MAX_PROFILES = 8, MIN_PROFILES = 2;
const profileDialog = $(".spy-profile-dialog");
const profileSlot = $(".spy-profile-slot");
const profiles = [];   // regular requests, without figure settings
let editingIndex = null; // the row being edited, or null when adding a new profile
let borrowedForm = null;

// The request forms keep a marker at their normal spot, so they can return after being borrowed.
const formHomes = new Map($$(".spy-panel").map((form) => {
  const marker = document.createComment("request form");
  form.before(marker);
  return [form, marker];
}));

function borrowForm(source) {
  returnForm();
  const form = $(`.spy-panel[data-source="${source}"]`);
  profileSlot.append(form);
  form.hidden = false;
  $(".spy-submit span", form).textContent = editingIndex === null ? "Add to composite" : "Save profile";
  borrowedForm = form;
  $$("[data-profile-type]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.profileType === source)));
  initMap(form);
  return form;
}

function returnForm() {
  if (!borrowedForm) return;
  $(".spy-submit span", borrowedForm).textContent = "Get sounding";
  borrowedForm.hidden = true;
  formHomes.get(borrowedForm).after(borrowedForm);
  borrowedForm = null;
}

function openProfileDialog({ index = null, request = null } = {}) {
  editingIndex = index;
  $("#spy-profile-title").textContent = index === null ? "Add a profile" : `Edit profile ${String.fromCharCode(65 + index)}`;
  profileDialog.showModal();
  borrowForm(request?.source ?? borrowedSource);
  if (request) fillForm(request);
}

let borrowedSource = "raob"; // the pop-up reopens on the last data type used

function saveProfile(form) {
  let request;
  try { request = buildRequest(form); } catch (err) { return showError(err, "Check this profile"); }
  delete request.settings;
  borrowedSource = request.source;
  if (editingIndex === null) profiles.push(request);
  else profiles[editingIndex] = request;
  profileDialog.close();
  renderProfiles();
}

function renderProfiles() {
  const full = profiles.length >= MAX_PROFILES;
  $(".spy-profile-count").textContent = `${profiles.length} of ${MAX_PROFILES}`;
  $(".spy-profile-empty").hidden = profiles.length > 0;
  $("[data-add-profile]").disabled = full;
  $("[data-build-composite]").disabled = profiles.length < MIN_PROFILES;

  const action = (label, handler, disabled = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener("click", handler);
    return button;
  };
  $(".spy-profile-list").replaceChildren(...profiles.map((request, i) => {
    const row = document.createElement("li");
    const letter = document.createElement("b");
    const text = document.createElement("span");
    const actions = document.createElement("div");
    letter.textContent = String.fromCharCode(65 + i);
    text.textContent = describeRequest({ ...request, settings: {} });
    actions.append(
      action("Edit", () => openProfileDialog({ index: i, request })),
      // Opens a prefilled new profile, so only the forecast hour or site needs changing.
      action("Duplicate", () => openProfileDialog({ request }), full),
      action("Remove", () => { profiles.splice(i, 1); renderProfiles(); }),
    );
    row.append(letter, text, actions);
    return row;
  }));
}

$("[data-add-profile]").addEventListener("click", () => openProfileDialog());
$("[data-close-profile]").addEventListener("click", () => profileDialog.close());
profileDialog.addEventListener("click", (e) => { if (e.target === profileDialog) profileDialog.close(); }); // backdrop
profileDialog.addEventListener("close", () => { borrowedSource = borrowedForm?.dataset.source ?? borrowedSource; returnForm(); });
$$("[data-profile-type]").forEach((b) => b.addEventListener("click", () => borrowForm(b.dataset.profileType)));
$("[data-build-composite]").addEventListener("click", () => showError(
  new Error(`The server side of composites isn't connected yet, so these ${profiles.length} profiles can't be plotted.`),
  "Composite preview",
));
renderProfiles();

// ---- Shareable links and saved settings -------------------------------------------
// A sounding's request lives in the address (?source=raob&site=OAX&date=…&hour=12), so copying
// the URL reproduces it. Figure settings are added only where they differ from the defaults.
// The settings you change are also remembered in this browser for your next visit.

const REQUEST_KEYS = ["site", "profile", "model", "fcst_hr", "lat", "lon", "date", "hour"];
const SAVED_SETTINGS = "sounderpy-settings";

// Settings fields that differ from their defaults, as [name, value] pairs.
function changedSettings() {
  const changed = [];
  for (const el of settingsForm.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") {
      if (el.checked !== el.defaultChecked) changed.push([el.name, el.checked ? "1" : "0"]);
    } else if (el.tagName === "SELECT") {
      const initial = [...el.options].find((o) => o.defaultSelected) ?? el.options[0];
      if (el.value !== initial.value) changed.push([el.name, el.value]);
    } else if (el.value !== el.defaultValue) {
      changed.push([el.name, el.value]);
    }
  }
  return changed;
}

function applySettings(pairs) {
  settingsForm.reset();
  for (const [name, value] of pairs) {
    const el = settingsForm.elements.namedItem(name);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = value === "1";
    else el.value = value;
  }
  updateSettingsCount();
}

function saveSettings() {
  try {
    const changed = changedSettings();
    if (changed.length) localStorage.setItem(SAVED_SETTINGS, JSON.stringify(changed));
    else localStorage.removeItem(SAVED_SETTINGS);
  } catch { /* private mode or storage blocked: settings just aren't remembered */ }
}

function savedSettings() {
  try { return JSON.parse(localStorage.getItem(SAVED_SETTINGS)) ?? []; } catch { return []; }
}

// Compared by value, never built into a selector: these strings come straight from the URL.
const isTab = (name) => $$("[data-tab]").some((t) => t.dataset.tab === name);

function requestUrl(req) {
  const params = new URLSearchParams({ source: req.source });
  for (const key of REQUEST_KEYS) if (req[key] != null && req[key] !== "") params.set(key, req[key]);
  for (const [name, value] of changedSettings()) params.set(name, value);
  return `${location.pathname}?${params}`;
}

function requestFromUrl() {
  const params = new URLSearchParams(location.search);
  const source = params.get("source");
  if (!isTab(source) || source === "composite") return null; // composites have no share links yet
  const req = { source };
  for (const key of REQUEST_KEYS) if (params.get(key)) req[key] = params.get(key);
  if (req.fcst_hr != null) req.fcst_hr = Number(req.fcst_hr);
  if (req.lat != null) { req.lat = Number(req.lat); req.lon = Number(req.lon); }
  const settings = [...params].filter(([name]) => settingsForm.elements.namedItem(name));
  return { req, settings };
}

// Put a shared request back into its form, so it can be tweaked and re-run.
function fillForm(req) {
  const form = $(`.spy-panel[data-source="${req.source}"]`);
  const field = (name) => form.elements.namedItem(name);
  if (req.source === "reanalysis") {
    field("coords").value = `${req.lat}, ${req.lon}`;
    field("coords").dispatchEvent(new Event("change"));
  } else if (req.source === "acars") {
    const profile = { id: req.profile, hour: req.hour, code: String(req.profile).slice(0, 3) };
    field("profile").replaceChildren(new Option(`${req.profile} (${req.hour}Z)`, JSON.stringify(profile), true, true));
  }
  for (const key of ["site", "model", "fcst_hr", "date", "hour"]) {
    if (!field(key) || (req.source === "acars" && key === "hour")) continue; // ACARS: the profile carries the hour
    field(key).value = req[key] ?? ""; // e.g. clears a BUFKIT run date for a "latest run" link
  }
  field("site")?.dispatchEvent(new Event("input")); // highlights it on the map
}

// Opens the sounding described by the current URL; returns false if there isn't one.
function openFromUrl() {
  const shared = requestFromUrl();
  if (!shared) return false;
  showTab(shared.req.source, { keepUrl: true });
  applySettings(shared.settings);
  fillForm(shared.req);
  runSounding({ ...shared.req, settings: readSettings() });
  return true;
}

window.addEventListener("popstate", () => {
  if (openFromUrl()) return;
  const tab = location.hash.slice(1);
  showTab(isTab(tab) ? tab : currentTab, { keepUrl: true });
  clearResult();
});

$("[data-copy-link]").addEventListener("click", async (e) => {
  const button = e.currentTarget, label = $("span", button);
  if (!lastShareUrl) return;
  try {
    await navigator.clipboard.writeText(new URL(lastShareUrl, location.origin).href);
    label.textContent = "Link copied!";
  } catch {
    label.textContent = "Copy it from the address bar";
  }
  setTimeout(() => { label.textContent = "Copy link"; }, 2000);
});

if (!openFromUrl()) {
  applySettings(savedSettings());
  const tab = location.hash.slice(1);
  showTab(isTab(tab) ? tab : "raob");
}
loadLatestRuns();

// ---- Status bar: server health and UTC clock ----------------------------------

const HEALTH_INTERVAL = 60_000;
const health = $(".spy-health");

async function checkHealth() {
  const text = $(".spy-health-text");
  try {
    const info = await (await api("/api/health")).json();
    health.dataset.state = "online";
    text.textContent = `Server online · SounderPy v${info.sounderpy_version}`;
    $(".spy-footer-version").textContent = ` v${info.sounderpy_version}`;
  } catch {
    health.dataset.state = "offline";
    text.textContent = "Server offline · soundings are unavailable right now";
  }
}
checkHealth();
setInterval(checkHealth, HEALTH_INTERVAL);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkHealth(); });

const clock = $(".spy-utc");
function tickClock() {
  const now = new Date();
  clock.dateTime = now.toISOString();
  clock.textContent = `${utc(now, { weekday: "short", month: "short", day: "numeric" })} · ${utc(now, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })} UTC`;
}
tickClock();
setInterval(tickClock, 1000);

// ---- Footer: copy the citation ----------------------------------------------------

$("[data-copy-citation]").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  try {
    await navigator.clipboard.writeText($(".spy-citation").textContent.replace(/\s+/g, " ").trim());
    button.textContent = "Copied!";
  } catch {
    button.textContent = "Select the text to copy";
  }
  setTimeout(() => { button.textContent = "Copy citation"; }, 2000);
});
