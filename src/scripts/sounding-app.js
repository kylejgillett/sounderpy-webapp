// Behaviour for the sounding-analysis pages. Expects the markup from
// src/components/sounding/* inside an element with class "spy".

import { createViewer } from "./image-viewer.js";
import { readSoundingFile } from "./sounding-file.js";

// `npm run dev` talks to a local API (uvicorn api:app --port 8000); builds use the droplet.
const API = (import.meta.env.PUBLIC_SOUNDERPY_API
  ?? (import.meta.env.DEV ? "http://localhost:8000" : "https://api.sounderpy.app")).replace(/\/$/, "");

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const status = $(".spy-status");
const result = $(".spy-result");
const settingsEl = $("#settings");
const isMobile = window.matchMedia?.("(pointer: coarse)").matches ?? false; // phones and tablets get the app-like extras
let lastRequest = null;
let srHodoSounding = false; // whether the server can draw full soundings storm relative (from /api/health)
let lastShareUrl = null; // address of the sounding on screen, with the settings it was made with
let lastPlotFile = null; // the plot on screen as a file, ready for the phone's share sheet

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
  $("[data-build-composite]").disabled = busy || profiles.length < MIN_PROFILES;
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
    sr_hodo: f("sr_hodo").checked,
    hodo_boundary_angle: num(f("hodo_boundary_angle").value),
    map_zoom: Math.min(num(f("map_zoom").value) ?? 0, 4), // the server's limit, for old share links too
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
  if (form.dataset.source === "upload") return uploadRequest(form);
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
  if (req.source === "bufkit") {
    const model = req.model.toUpperCase(), hasRun = Boolean(req.date && req.hour);
    if (ARCHIVE_ONLY.includes(req.model) && !hasRun) {
      throw new Error(`The ${model} has been replaced by the RRFS, so only its past runs are available. Enter a run date and hour, or choose the RRFS for the latest forecast.`);
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
  composite: "Composite soundings · Experimental",
  upload: "User-supplied data · Not verified by SounderPy",
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
    composite: [`Composite of ${req.profiles?.length} soundings`],
    upload: [req.title || "Custom Sounding", req.date && `${req.date} ${req.time}Z`],
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
    s.sr_hodo && (s.hodo || srHodoSounding ? "Storm-relative hodograph" : "Storm-relative (hodograph-only plots)"),
    s.hodo_boundary_angle != null && `Boundary axis at ${s.hodo_boundary_angle}°`,
    s.map_zoom !== 0 && `Map zoom ${s.map_zoom}`,
    s.radar && `Radar: ${{ "single-site": "NEXRAD site", mosaic: "MRMS mosaic" }[s.radar]}${s.radar_time ? ` at ${s.radar_time.replace("T", " ")} UTC` : ""}`,
    sm && `Storm motion: ${sm}`,
    sfc && `Surface modified: ${sfc}`,
  ].filter(Boolean);
}

function loadingHint(req) {
  if (req.source === "composite") return "Each profile is fetched separately, so this can take a minute.";
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
  const chips = req.source === "composite"
    ? req.profiles.map((p, i) => `${String.fromCharCode(65 + i)}: ${describeRequest({ ...p, settings: {} })}`)
    : settingsSummary(req.settings);
  $(".spy-loading-settings").replaceChildren(...chips.map((text) => {
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

function renderCaption(req, label, info, levels) {
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
    if (req.source === "upload") {
      row("Valid", `${req.time} UTC ${req.date}`);
      row("At", [req.location, coords(req.lat, req.lon)].filter(Boolean).join(", "));
      if (levels.plotted < levels.received) row("Levels", `${levels.plotted} plotted of ${levels.received.toLocaleString()} in the file`);
    }
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
  lastPlotFile = null;
  updateShareButton();
  delete $(".spy").dataset.result;
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
  const isComposite = req.source === "composite", isUpload = req.source === "upload";
  const shareUrl = isComposite || isUpload ? null : requestUrl(req); // captured now, so later setting changes don't alter it
  setBusy(true);
  startLoading(req);
  result.scrollIntoView({ behavior: "smooth", block: "nearest" });
  try {
    const path = isComposite ? "/api/composite" : isUpload ? "/api/upload-sounding" : "/api/sounding";
    const { label, info, image, levels } = await (await api(path, req)).json();
    if (id !== requestId) return;
    lastRequest = req;
    $(".spy").dataset.result = isComposite ? "composite" : isUpload ? "upload" : "sounding"; // these two hide data-file downloads
    renderCaption(req, label, info, levels);
    const img = $("img", result);
    img.src = image;
    img.alt = label;
    $('[data-download="png"]').href = image;
    lastShareUrl = shareUrl;
    preparePlotFile(image, id);
    jumpToPlot(img, id);
    if (record && shareUrl && shareUrl !== location.pathname + location.search) history.pushState(null, "", shareUrl);
    setBusy(false);
    stopLoading();
  } catch (err) {
    if (id !== requestId) return;
    stopLoading();
    showError(err, isComposite ? "Couldn't build that composite" : "Couldn't get that sounding");
  }
}

// Bring the finished plot into view, once it's ready to paint so the page doesn't shift underneath.
async function jumpToPlot(img, id) {
  if (!isMobile) return;
  await img.decode?.().catch(() => {});
  if (id !== requestId || document.hidden) return;
  const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  result.scrollIntoView({ behavior: calm ? "instant" : "smooth", block: "start" });
  try { navigator.vibrate?.(40); } catch { /* no vibration here */ }
}

// ---- Share: the phone's own share sheet. Phones that can't share files share the link instead. ----

const shareButton = $("[data-share]");
const canShareFile = () => Boolean(lastPlotFile && navigator.canShare?.({ files: [lastPlotFile] }));

function updateShareButton() {
  shareButton.hidden = !(isMobile && navigator.share && (canShareFile() || lastShareUrl));
}

// Made ahead of time: browsers only allow sharing straight after the tap.
async function preparePlotFile(image, id) {
  try {
    const blob = await (await fetch(image)).blob();
    if (id !== requestId) return;
    lastPlotFile = new File([blob], "sounderpy_plot.png", { type: "image/png" });
  } catch { /* the link can still be shared */ }
  updateShareButton();
}

shareButton.addEventListener("click", async () => {
  const note = $("small", shareButton);
  const title = $(".spy-title").textContent;
  try {
    await navigator.share(canShareFile() ? { files: [lastPlotFile], title } : { title, url: new URL(lastShareUrl, location.origin).href });
  } catch (err) {
    if (err.name !== "AbortError") flash(note, "couldn't share, use PNG", "send this plot"); // AbortError: they closed the sheet
  }
});

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

// Shows when RAOB sites last launched, from the last two days. The buttons narrow that to one launch
// time, or to the form's date and hour. If the lists can't load, the map just shows every site as usual.
const LAUNCH_HOURS = ["00", "06", "12", "18"];
const DAY_MS = 86400000;

function launchInfo(time, now = Date.now()) {
  const date = new Date(time);
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return { hour, when: `${hour}Z ${day}`, date: time.slice(0, 10), fresh: now - date.getTime() <= DAY_MS };
}

function launchesFor(stations, info) {
  return new Map(stations.map((id) => [id.toUpperCase(), info]));
}

function trackLaunches(form, map, layer, launchControl) {
  let cycles = [], view = "all", shown = new Map(), latest = 0;
  const views = [["all", "All"], ...LAUNCH_HOURS.map((hour) => [hour, `${hour}Z`]), ["date", "Form date"]];
  const control = launchControl(map, views, (next) => { view = next; show(); });

  const newestAt = (hour) => cycles.find((cycle) => launchInfo(cycle.time).hour === hour);

  async function show() {
    const request = ++latest;
    control.setActive(view);
    control.setLoading("date", false);
    if (view === "date") {
      const hour = parseHour(form.hour.value);
      if (!form.date.value || !hour) return layer.setLaunches(shown = new Map(), true);
      control.setLoading("date", true);
      try {
        const res = await api(`/api/raob/launches?date=${form.date.value}&hour=${Number(hour)}`);
        const { stations } = await res.json();
        if (request !== latest) return;
        const info = launchInfo(`${form.date.value}T${hour}:00:00Z`);
        layer.setLaunches(shown = launchesFor(stations, info), true);
        control.setView("date", { title: `${info.when}: ${stations.length} sites` });
        control.setLoading("date", false);
      } catch (err) {
        if (request !== latest) return;
        console.error(err);
        control.setView("date", { title: "This launch list isn't available right now" });
        control.setLoading("date", false);
        layer.setLaunches(shown = new Map(), false);
      }
    } else if (view === "all") {
      // Newest last, so each site ends up with its most recent launch.
      shown = new Map();
      for (const cycle of [...cycles].reverse()) launchesFor(cycle.stations, launchInfo(cycle.time)).forEach((info, id) => shown.set(id, info));
      layer.setLaunches(shown, false);
    } else {
      const cycle = newestAt(view);
      layer.setLaunches(shown = launchesFor(cycle.stations, launchInfo(cycle.time)), true);
    }
  }

  async function load() {
    for (const hour of LAUNCH_HOURS) control.setView(hour, { disabled: true, title: "Loading…" });
    try {
      const res = await api("/api/raob/launches/recent");
      cycles = (await res.json()).cycles;
      for (const hour of LAUNCH_HOURS) {
        const cycle = newestAt(hour);
        control.setView(hour, cycle?.stations.length
          ? { title: `${launchInfo(cycle.time).when}: ${cycle.stations.length} sites` }
          : { disabled: true, title: `No ${hour}Z launches in the last two days` });
      }
    } catch (err) {
      console.error(err);
      for (const hour of LAUNCH_HOURS) control.setView(hour, { disabled: true, title: "The launch list isn't available right now" });
    }
    if (view === "all") show();
  }

  const followForm = () => { if (view === "date") show(); };
  form.date.addEventListener("change", followForm);
  form.hour.addEventListener("change", followForm);
  control.setActive(view);
  load();

  return {
    // Fill the form with the launch the map is showing for this site.
    pick(id) {
      const launch = view !== "date" && shown.get(String(id).toUpperCase());
      if (!launch) return;
      form.date.value = launch.date;
      form.hour.value = launch.hour;
    },
  };
}

async function initMap(form) {
  const source = form.dataset.source;
  if (maps[source]) return maps[source].map?.invalidateSize();
  maps[source] = {};
  const el = $(".spy-map", form);

  try {
    const { createBaseMap, fetchData, stationLayer, launchControl, pointPicker, airportLayer, FAINT_DOT, BUFKIT_MODEL_CODES } = await import("./station-map.js");
    const map = maps[source].map = createBaseMap(el);

    if (source === "raob" || source === "bufkit") {
      const rows = await fetchData(`${source}-stations.json`);
      let launches = null;
      const layer = stationLayer(map, rows, { onPick: ([id]) => { form.site.value = id; launches?.pick(id); } });
      layer.select(form.site.value);
      form.site.addEventListener("input", () => layer.select(form.site.value, { pan: true }));
      if (source === "raob") launches = trackLaunches(form, map, layer, launchControl);
      if (source === "bufkit") {
        // Fade stations without the chosen model. A station with no model list is left alone.
        const filter = () => {
          const code = BUFKIT_MODEL_CODES[form.model.value];
          layer.setAvailable((row) => !row[6] || row[6].includes(code));
        };
        form.model.addEventListener("change", filter);
        filter();
      }
    } else if (source === "reanalysis") {
      const picker = pointPicker(map, { onPick: (lat, lon) => { form.coords.value = `${lat}, ${lon}`; } });
      form.coords.addEventListener("change", () => {
        const [lat, lon] = form.coords.value.split(",").map(Number);
        if (Number.isFinite(lat) && Number.isFinite(lon)) picker.set(lat, lon, { pan: true });
      });
    } else if (source === "upload") {
      const picker = pointPicker(map, { onPick: (lat, lon) => { form.lat.value = lat; form.lon.value = lon; } });
      const follow = () => {
        const lat = num(form.lat.value), lon = num(form.lon.value);
        if (Number.isFinite(lat) && Number.isFinite(lon)) picker.set(lat, lon, { pan: true });
      };
      form.lat.addEventListener("change", follow);
      form.lon.addEventListener("change", follow);
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
  raob: "Observed soundings: University of Wyoming upper-air archive and IGRAv2 from NOAA.",
  acars: "Aircraft profiles: ACARS/AMDAR data from the University of Oklahoma SHARP archive.",
  bufkit: "Forecast soundings: Penn State BUFKIT feed and Iowa State IEM BUFKIT feed.",
  reanalysis: "Reanalysis: RAP and RUC model analyses from NOAA NCEI.",
  composite: "Composites combine the data sources of the profiles you add.",
  upload: "Uploaded soundings: data supplied by the user and not verified by SounderPy.",
};

// The installed app reopens on the tab you used last; a browser visit starts as usual.
const LAST_TAB = "sounderpy-last-tab";
const isInstalled = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
function startTab() {
  if (!isMobile || !isInstalled()) return "raob";
  try {
    const saved = localStorage.getItem(LAST_TAB);
    return isTab(saved) ? saved : "raob";
  } catch { return "raob"; }
}

// The phone-sized button that opens the tabs names the current one.
const tabsToggle = $(".spy-tabs-toggle");
function updateTabsToggle() {
  $("span", tabsToggle).textContent = $('[data-tab][aria-selected="true"]').textContent;
}

let currentTab = null;
function showTab(name, { keepUrl = false } = {}) {
  if (currentTab && currentTab !== name) clearResult();
  currentTab = name;
  try { localStorage.setItem(LAST_TAB, name); } catch { /* not remembered */ }
  $(".spy-credit").textContent = CREDITS[name];
  $$("[data-tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  updateTabsToggle();
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
  if (!["bufkit", "upload"].includes(form.dataset.source) && !form.date.value) form.date.value = today;
}
// RAOB opens on the newest 00 or 12Z launch that's been checked, an hour after launch,
// so this can still be yesterday's date just after 00Z.
const checked = new Date(now.getTime() - 3600000);
$('[data-source="raob"] [name="date"]').value = checked.toISOString().slice(0, 10);
$('[data-source="raob"] [name="hour"]').value = checked.getUTCHours() >= 12 ? "12" : "00";
$('[data-source="acars"] [name="hour"]').value = String(utcHour).padStart(2, "0");

// Hour boxes that a sounding request depends on get a friendly native validation message.
// (ACARS is excluded: the picked profile carries its own hour.)
for (const input of $$('.spy-panel:not([data-source="acars"]) [name="hour"]')) {
  input.addEventListener("input", () => input.setCustomValidity(!input.value.trim() || parseHour(input.value) ? "" : HOUR_MESSAGE));
}

$$("[data-tab]").forEach((t) => t.addEventListener("click", () => {
  showTab(t.dataset.tab);
  tabsToggle.setAttribute("aria-expanded", "false");
}));
tabsToggle.addEventListener("click", () => {
  tabsToggle.setAttribute("aria-expanded", String(tabsToggle.getAttribute("aria-expanded") !== "true"));
});
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
  // On a server whose SounderPy has no sr_hodo for full soundings, say when the option won't apply.
  $("[data-sr-note]").hidden = srHodoSounding || !(settingsForm.elements.namedItem("sr_hodo").checked && !settingsForm.elements.namedItem("hodo").checked);
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

const MAX_PROFILES = 6, MIN_PROFILES = 2;
const profileDialog = $(".spy-profile-dialog");
const profileSlot = $(".spy-profile-slot");
const profiles = [];   // regular requests, without figure settings, each with a line `style`
// Line defaults match SounderPy's build_composite. Custom colors only apply when chosen under Line colors.
const LINE_COLORS = ["#e8c468", "#6fb3a8", "#e2876a", "#a7c957", "#c58fd6", "#7fb2e5", "#f3ead6", "#d96c75"];
const LINE_STYLES = [["-", "Solid"], ["--", "Dashed"], [":", "Dotted"], ["-.", "Dash-dot"]];
const LINE_WIDTHS = [1, 2, 3, 4, 5, 6].map((w) => [w, String(w)]);
const LINE_OPACITIES = [[1, "100%"], [0.75, "75%"], [0.5, "50%"], [0.25, "25%"]];
const nextLineColor = () => LINE_COLORS.find((c) => !profiles.some((p) => p.style.color === c)) ?? LINE_COLORS[profiles.length % LINE_COLORS.length];
const newLineStyle = () => ({ ls: "-", lw: 3, alpha: 1, color: nextLineColor() });
let pendingStyle = null; // line style carried over when duplicating a row
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
  // A timeseries makes new rows, so it isn't offered while editing one row.
  $$("[data-forecast-series]", form).forEach((b) => { b.hidden = editingIndex !== null; });
  $$("[data-profile-type]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.profileType === source)));
  initMap(form);
  return form;
}

function returnForm() {
  if (!borrowedForm) return;
  $(".spy-submit span", borrowedForm).textContent = "Get sounding";
  $$("[data-forecast-series]", borrowedForm).forEach((b) => { b.hidden = false; });
  borrowedForm.hidden = true;
  formHomes.get(borrowedForm).after(borrowedForm);
  borrowedForm = null;
}

function openProfileDialog({ index = null, request = null } = {}) {
  editingIndex = index;
  pendingStyle = request?.style ?? null;
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
  if (editingIndex === null) {
    request.style = pendingStyle ? { ...pendingStyle, color: nextLineColor() } : newLineStyle();
    profiles.push(request);
  } else {
    request.style = profiles[editingIndex].style;
    profiles[editingIndex] = request;
  }
  profileDialog.close();
  renderProfiles();
}

// One row's line controls. They edit the profile's style in place, so the list isn't redrawn.
function lineControls(style) {
  const box = document.createElement("div");
  box.className = "spy-profile-style";
  const select = (label, key, options) => {
    const wrap = document.createElement("label");
    const input = document.createElement("select");
    input.setAttribute("aria-label", label);
    input.append(...options.map(([value, text]) => new Option(text, value)));
    input.value = style[key];
    input.addEventListener("change", () => { style[key] = key === "ls" ? input.value : Number(input.value); });
    wrap.append(label, input);
    return wrap;
  };
  const color = document.createElement("label");
  const picker = document.createElement("input");
  color.className = "spy-profile-color";
  picker.type = "color";
  picker.value = style.color;
  picker.setAttribute("aria-label", "Line color");
  picker.addEventListener("input", () => { style.color = picker.value; });
  color.append("Color", picker);
  box.append(color, select("Style", "ls", LINE_STYLES), select("Width", "lw", LINE_WIDTHS), select("Opacity", "alpha", LINE_OPACITIES));
  return box;
}

// The /api/composite request; names match SounderPy's build_composite arguments.
function compositeRequest() {
  const options = $(".spy-composite-options");
  const field = (name) => options.querySelector(`[name="${name}"]`);
  const cmap = field("cmap").value;
  const smDir = num(field("sm_dir").value), smSpd = num(field("sm_spd").value);
  if ((smDir === null) !== (smSpd === null)) throw new Error("Enter both a custom storm direction and speed, or leave both blank.");
  const style = field("style").value;
  return {
    source: "composite",
    profiles: profiles.map(({ style, ...request }) => request),
    settings: {
      dark_mode: options.querySelector('[name="dark_mode"]').checked,
      shade_between: options.querySelector('[name="shade_between"]').checked,
      ...(cmap === "custom" ? { colors_to_use: profiles.map((p) => p.style.color) } : { cmap }),
      ls_to_use: profiles.map((p) => p.style.ls),
      lw_to_use: profiles.map((p) => p.style.lw),
      alphas_to_use: profiles.map((p) => p.style.alpha),
      style,
      sr_hodo: style !== "sounding" && field("sr_hodo").checked,
      show_params: field("show_params").checked,
      storm_motion: smDir !== null ? [smDir, smSpd] : field("storm_motion").value,
    },
  };
}

function renderProfiles() {
  const full = profiles.length >= MAX_PROFILES;
  $(".spy-profile-count").textContent = `${profiles.length} of ${MAX_PROFILES}`;
  $(".spy-profile-empty").hidden = profiles.length > 0;
  $("[data-add-profile]").disabled = full;
  $("[data-clear-profiles]").hidden = profiles.length === 0;
  $("[data-build-composite]").disabled = profiles.length < MIN_PROFILES;
  $('[data-tab="composite"]').textContent = profiles.length ? `Composite soundings (${profiles.length})` : "Composite soundings";
  updateTabsToggle();

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
    row.append(letter, text, actions, lineControls(request.style));
    return row;
  }));
}

// "Use in a composite" on a finished sounding: add it to the list and go to the Composite tab.
$("[data-use-in-composite]").addEventListener("click", () => {
  if (!lastRequest) return;
  const { settings, ...request } = lastRequest;
  const summary = describeRequest({ ...request, settings: {} });
  const existing = profiles.findIndex((p) => describeRequest({ ...p, settings: {} }) === summary);
  if (existing < 0 && profiles.length >= MAX_PROFILES) {
    return showError(new Error(`The composite already has ${MAX_PROFILES} profiles. Remove one to add this sounding.`), "Composite is full");
  }
  if (existing < 0) profiles.push({ ...request, style: newLineStyle() });
  borrowedSource = request.source;
  renderProfiles();
  showTab("composite");
  $("[data-composite]").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

// ---- Forecast timeseries: many forecast hours of one BUFKIT site and run ----------

const FORECAST_LIMITS = { gfs: 180, hrrr: 48, rap: 51, rrfs: 84, nam: 48, namnest: 60 }; // from SounderPy
const ARCHIVE_ONLY = ["nam", "namnest"]; // replaced by the RRFS: past runs only
const seriesDialog = $(".spy-series");
const seriesField = (name) => $(`.spy-series [name="${name}"]`);
const seriesMode = () => $('.spy-series [name="series_mode"]:checked').value;
let seriesBase = null; // the BUFKIT request, without a forecast hour

// The forecast hours asked for, or the reason they can't be used.
function seriesPlan() {
  const [from, to, every] = ["series_from", "series_to", "series_every"].map((n) => Number(seriesField(n).value));
  const filled = ["series_from", "series_to", "series_every"].every((n) => seriesField(n).value !== "");
  if (!filled || ![from, to, every].every(Number.isInteger) || from < 0 || every < 1) return { error: "Enter whole numbers for the hours and interval." };
  if (to < from) return { error: "The last forecast hour must come after the first." };
  const limit = FORECAST_LIMITS[seriesBase.model];
  if (to > limit) return { error: `The ${seriesBase.model.toUpperCase()} only goes out to F${pad2(limit)}.` };
  const hours = [];
  for (let h = from; h <= to; h += every) hours.push(h);
  if (hours.length > MAX_PROFILES) return { error: `That's ${hours.length} profiles, and the limit is ${MAX_PROFILES}. Widen the interval or shorten the range.` };
  if (profiles.length && seriesMode() === "add" && profiles.length + hours.length > MAX_PROFILES) {
    return { error: `That's ${hours.length} profiles, but only ${MAX_PROFILES - profiles.length} more fit. Replace your list or shorten the range.` };
  }
  return { hours };
}

function updateSeries() {
  const { hours, error } = seriesPlan();
  const preview = $(".spy-series-preview");
  preview.textContent = error ?? `${hours.map((h) => `F${pad2(h)}`).join(", ")} (${hours.length} profile${hours.length === 1 ? "" : "s"})`;
  preview.classList.toggle("is-error", Boolean(error));
  $("[data-create-series]").disabled = Boolean(error);
}

function openSeries(form) {
  let request;
  try { request = buildRequest(form); } catch (err) { return showError(err, "Check your forecast timeseries"); }
  if (!request.site?.trim()) return showError(new Error("Choose a BUFKIT site first: click one on the map or type its ID."), "Check your forecast timeseries");
  const hourText = form.elements.namedItem("hour").value.trim();
  if (hourText && !request.hour) return showError(new Error(HOUR_MESSAGE), "Check your forecast timeseries");
  const { settings, fcst_hr, ...base } = request;
  if (!base.hour) delete base.date; // no run hour means the latest run
  seriesBase = base;
  $(".spy-series-source").textContent = [base.model.toUpperCase(), base.site.toUpperCase(), base.hour ? `run ${base.date} ${base.hour}Z` : "latest run"].join("  ·  ");
  const from = fcst_hr ?? 1;
  seriesField("series_from").value = from;
  seriesField("series_every").value = 3;
  seriesField("series_to").value = Math.min(from + 15, FORECAST_LIMITS[base.model]);
  $(".spy-series-mode").hidden = profiles.length === 0;
  $(`.spy-series [name="series_mode"][value="${profiles.length >= MAX_PROFILES ? "replace" : "add"}"]`).checked = true;
  $('.spy-series [name="series_mode"][value="add"]').disabled = profiles.length >= MAX_PROFILES;
  seriesDialog.showModal();
  updateSeries();
}

$("[data-forecast-series]").addEventListener("click", (e) => openSeries(e.currentTarget.form));
seriesDialog.addEventListener("input", updateSeries);
seriesDialog.addEventListener("change", updateSeries);
seriesDialog.addEventListener("click", (e) => { if (e.target === seriesDialog) seriesDialog.close(); }); // backdrop
$$("[data-close-series]").forEach((b) => b.addEventListener("click", () => seriesDialog.close()));
$("[data-create-series]").addEventListener("click", () => {
  const { hours } = seriesPlan();
  if (!hours) return;
  if (seriesMode() === "replace") profiles.length = 0;
  for (const fcst_hr of hours) profiles.push({ ...seriesBase, fcst_hr, style: newLineStyle() });
  borrowedSource = "bufkit";
  seriesDialog.close();
  if (profileDialog.open) profileDialog.close();
  renderProfiles();
  showTab("composite");
  $("[data-composite]").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

$("[data-add-profile]").addEventListener("click", () => openProfileDialog());
$("[data-clear-profiles]").addEventListener("click", () => {
  if (!window.confirm(`Remove all ${profiles.length} profiles from this composite?`)) return;
  profiles.length = 0;
  renderProfiles();
});
$("[data-close-profile]").addEventListener("click", () => profileDialog.close());
profileDialog.addEventListener("click", (e) => { if (e.target === profileDialog) profileDialog.close(); }); // backdrop
profileDialog.addEventListener("close", () => { borrowedSource = borrowedForm?.dataset.source ?? borrowedSource; returnForm(); });
$$("[data-profile-type]").forEach((b) => b.addEventListener("click", () => borrowForm(b.dataset.profileType)));
$('.spy-composite-options [name="cmap"]').addEventListener("change", (e) => {
  $(".spy-profile-list").classList.toggle("is-custom", e.target.value === "custom");
});
$("[data-build-composite]").addEventListener("click", () => {
  let request;
  try { request = compositeRequest(); } catch (err) { return showError(err, "Check your composite"); }
  runSounding(request);
});
// A storm-relative hodograph needs a hodograph panel.
$('.spy-composite-options [name="style"]').addEventListener("change", (e) => {
  $('.spy-composite-options [name="sr_hodo"]').disabled = e.target.value === "sounding";
});
renderProfiles();

// ---- Upload tab: read a sounding file here, then send its numbers ----------------------

const uploadForm = $('[data-source="upload"]');
const uploadSummary = $(".spy-upload-summary");
const uploadName = $(".spy-upload-name");
const UPLOAD_PROMPT = uploadName.textContent;
let uploaded = null; // what was read from the chosen file
let filledFrom = {}; // what the last file put in each box, so a new file replaces only that

// Set a box from the file, unless the user has typed their own value.
function fillFromFile(field, value) {
  if (!field.value || field.value === filledFrom[field.name]) field.value = value;
  filledFrom[field.name] = value;
}

// The file's name without its extension, as a title the server accepts.
const titleFromFile = (name, length = 40) => name.replace(/\.[^.]*$/, "").replace(/[^\p{L}\p{N}_ .,:;'()/#+|-]+/gu, " ").trim().slice(0, length).trim();

// "23", "23Z", "2315", "23:15" -> "23:15"; anything else -> null. Text, not a time box, so it's always 24-hour.
function parseTime(value) {
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*z?$/i.exec(String(value).trim());
  return m && Number(m[1]) <= 23 && Number(m[2] ?? 0) <= 59 ? `${m[1].padStart(2, "0")}:${m[2] ?? "00"}` : null;
}

function uploadRequest(form) {
  if (!uploaded) throw new Error("Choose a sounding file first.");
  const time = parseTime(form.time.value);
  if (!time) throw new Error("Enter a UTC time from 0000 to 2359, e.g. 2315.");
  return {
    source: "upload",
    title: form.title.value,
    location: form.location.value,
    right_title: form.use_filename.checked ? titleFromFile(form.file.files[0].name, 30) : "",
    date: form.date.value,
    time,
    lat: num(form.lat.value),
    lon: num(form.lon.value),
    ...(uploaded.format === "cm1"
      ? { cm1: { surface_pressure: uploaded.surface[0], surface_theta: uploaded.surface[1], surface_qv: uploaded.surface[2], rows: uploaded.rows, elevation: num(form.elevation.value) } }
      : { rows: uploaded.rows }),
    settings: readSettings(),
  };
}

// "Use my location": asks only when tapped, and stays on this device until a plot is made.
const locateButton = $("[data-locate]");
locateButton.hidden = !isMobile || !navigator.geolocation;
locateButton.addEventListener("click", () => {
  const label = $("span", locateButton);
  label.textContent = "Finding you…";
  locateButton.disabled = true;
  const done = () => { label.textContent = "Use my location"; locateButton.disabled = false; };
  navigator.geolocation.getCurrentPosition((position) => {
    done();
    uploadForm.lat.value = position.coords.latitude.toFixed(3);
    uploadForm.lon.value = position.coords.longitude.toFixed(3);
    uploadForm.lon.dispatchEvent(new Event("change")); // moves the map pin
  }, (err) => {
    done();
    showError(new Error(err.code === err.PERMISSION_DENIED
      ? "Location access is turned off for this site. You can allow it in your settings, or click the map instead."
      : "Your location couldn't be found right now. Try again, or click the map instead."), "Couldn't get your location");
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
});

// Highlight the drop area while a file is dragged over it.
for (const [type, over] of [["dragenter", true], ["dragleave", false], ["drop", false]]) {
  uploadForm.file.addEventListener(type, () => uploadForm.file.parentElement.classList.toggle("is-over", over));
}

uploadForm.file.addEventListener("change", async () => {
  const file = uploadForm.file.files[0];
  uploaded = null;
  uploadName.textContent = file?.name ?? UPLOAD_PROMPT;
  uploadSummary.textContent = "";
  uploadSummary.classList.remove("is-error");
  if (!file) return;
  try {
    const read = await readSoundingFile(file);
    if (uploadForm.file.files[0] !== file) return; // another file was chosen meanwhile
    uploaded = read;
    $("[data-cm1-only]", uploadForm).hidden = read.format !== "cm1";
    fillFromFile(uploadForm.title, titleFromFile(file.name));
    fillFromFile(uploadForm.location, read.site);
    if (read.date) uploadForm.date.value = read.date;
    if (read.time) uploadForm.time.value = read.time;
    const skipped = read.skipped ? `, ${read.skipped} skipped for missing values` : "";
    const format = read.format === "cm1" ? "CM1" : "SHARPpy";
    uploadSummary.textContent = `Read ${read.rows.length.toLocaleString()} ${format} levels${skipped}.`;
  } catch (err) {
    uploadForm.file.value = "";
    uploadName.textContent = UPLOAD_PROMPT;
    uploadSummary.textContent = err.message;
    uploadSummary.classList.add("is-error");
  }
});

// ---- What's new: a dot on the link until this browser has opened the latest notes ---

const WHATS_NEW_SEEN = "sounderpy-whats-new-seen";
const whatsNewLink = $("[data-whats-new]");
const whatsNewDialog = $(".spy-whats-new");
const whatsNewDot = $(".spy-whats-new-dot");
let whatsNewSeen = null;
try { whatsNewSeen = localStorage.getItem(WHATS_NEW_SEEN); } catch { /* storage blocked: the dot just shows */ }
whatsNewDot.hidden = whatsNewSeen === whatsNewLink.dataset.whatsNew;
whatsNewLink.addEventListener("click", () => {
  whatsNewDialog.showModal();
  whatsNewDot.hidden = true;
  try { localStorage.setItem(WHATS_NEW_SEEN, whatsNewLink.dataset.whatsNew); } catch { /* not remembered */ }
});
$("[data-close-whats-new]").addEventListener("click", () => whatsNewDialog.close());
whatsNewDialog.addEventListener("click", (e) => { if (e.target === whatsNewDialog) whatsNewDialog.close(); }); // backdrop

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

// Saved settings exist only while "Remember my settings" is on (even an empty list counts).
const rememberBox = $("[data-remember-settings]");
function saveSettings() {
  try {
    if (rememberBox.checked) localStorage.setItem(SAVED_SETTINGS, JSON.stringify(changedSettings()));
    else localStorage.removeItem(SAVED_SETTINGS);
  } catch { /* private mode or storage blocked: settings just aren't remembered */ }
}
rememberBox.addEventListener("change", saveSettings);
try { rememberBox.checked = localStorage.getItem(SAVED_SETTINGS) !== null; } catch { /* storage blocked */ }

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
  if (!isTab(source) || source === "composite" || source === "upload") return null; // composites have no share links yet, and uploads are never stored
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
  field("hour")?.dispatchEvent(new Event("change")); // updates the map's launch list
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
  showTab(isTab(tab) ? tab : startTab());
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
    if (srHodoSounding !== Boolean(info.sr_hodo_sounding)) {
      srHodoSounding = Boolean(info.sr_hodo_sounding);
      updateSettingsCount();
    }
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

// ---- Offline: a small service worker (public/sw.js) shows a tidy page when there's no connection ---

if (import.meta.env.PROD && isMobile && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* the site works the same without it */ });
}

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
