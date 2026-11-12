"""HTTP API behind sounderpy.app: fetches sounding data and draws plots with SounderPy.

Run from this folder with:

    uvicorn api:app --host 127.0.0.1 --port 8000
"""

import base64
import io
import logging
import os
import re
import threading
import time
import warnings
import datetime as dt
from concurrent.futures import ThreadPoolExecutor
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from tempfile import TemporaryDirectory
from collections import defaultdict, deque
from typing import Annotated, Literal, Optional, Union

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

import diskcache
import metpy.calc as mpcalc
import numpy as np
import pandas as pd
import requests
import sounderpy as spy
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from metpy.units import units
from pydantic import BaseModel, Field, FiniteFloat, ValidationError, field_validator, model_validator

from sounderpy.data import ncep_bufr
from sounderpy.utils import SounderPyWarning, find_raob_station

from launches import get_launches, recent_launches
from und import create_router as create_und_router


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)
LOGGER = logging.getLogger("sounderpy-api")


# -----------------------------------------------------------------------------
# CONFIGURATION
# -----------------------------------------------------------------------------

try:
    SOUNDERPY_VERSION = version("sounderpy")
except PackageNotFoundError:
    SOUNDERPY_VERSION = "unknown"

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "ALLOWED_ORIGINS",
        "https://sounderpy.app,https://kylegillettphoto.com,http://localhost:4321,http://localhost:4322",
    ).split(",")
    if origin.strip()
]

AIRPORTS_CSV_URL = ("https://raw.githubusercontent.com/kylejgillett/sounderpy/main/src/AIRPORTS.csv")
AIRPORTS_FILE = Path(os.environ.get("AIRPORTS_FILE", str(Path(__file__).parent / "airports.csv")))  # last good copy
AIRPORTS_RETRY_SECONDS = 300

EXPORTS = {
    "csv": (".csv", "text/csv"),
    "cm1": (".snd", "text/plain"),
    "sharppy": (".txt", "text/plain"),
}

# Penn State serves the latest run of these; IEM archives past runs of the second list.
BUFKIT_MODELS = ["gfs", "rrfs", "rap", "hrrr"]
BUFKIT_ARCHIVE_MODELS = ["gfs", "rrfs", "rap", "hrrr", "nam", "namnest"]
# Retired with the NAM on Nov 3, 2026 (NWS SCN 26-48), and never archived, so nothing is left of them.
BUFKIT_RETIRED_MODELS = ["sref", "hiresw"]

# Old IDs in SounderPy's station list that BUFKIT files no longer use. Each maps to the station's
# current ID (same NCEP station number), so typed IDs and old share links still work.
# Kept off the map by scripts/build-station-data.mjs.
BUFKIT_RENAMED = {"KY26": "KMBG", "KBNG": "KBMG", "ISQ": "KISQ", "KFST": "KSTK", "K36U": "KHCR",
                  "KWIN": "WNTR", "KBNY": "BNY", "K2IS": "2IS", "OSC": "OSCR"}
# ...except Penn State's latest GFS files, which still use the old IDs for these two.
BUFKIT_GFS_LATEST = {"BNY": "KBNY", "2IS": "K2IS"}
BUFKIT_RETIRED = {"XLIK"}  # no data under any ID


# -----------------------------------------------------------------------------
# LOCKS / CACHES
# -----------------------------------------------------------------------------

# Retrieval is not locked. Only Matplotlib plotting is serialized.
PLOT_LOCK = threading.Lock()

LATEST_RUN_CACHE_LOCK = threading.Lock()
LATEST_RUN_CACHE = {"expires": 0.0, "data": None}
LATEST_RUN_CACHE_SECONDS = 300

# Fetched profiles, kept on disk and shared across restarts. Least recently used go first at the cap.
PROFILE_CACHE_DIR = os.environ.get("PROFILE_CACHE_DIR", str(Path(__file__).parent / "cache"))
PROFILE_CACHE_BYTES = int(os.environ.get("PROFILE_CACHE_BYTES", 2 * 1024 ** 3))
PROFILE_CACHE_LATEST_SECONDS = 300  # "latest run" requests: the next run can appear at any time
PROFILE_CACHE_RECENT_SECONDS = 3600  # the last two days: archives can still revise or fill in a profile
PROFILE_CACHE_SKIP_SOURCES = {"reanalysis"}

PROFILE_CACHE = diskcache.Cache(
    PROFILE_CACHE_DIR,
    size_limit=PROFILE_CACHE_BYTES,
    eviction_policy="least-recently-used",
)

# Uploaded soundings. The browser reads the file; this API only ever receives numbers and short labels,
# and keeps nothing: no disk, no cache, and only the level count and timing in the log.
UPLOADS_ENABLED = os.environ.get("UPLOADS_ENABLED", "1") != "0"  # off switch if uploads are ever abused
UPLOAD_MAX_BODY_BYTES = 1024 ** 2
UPLOAD_MAX_LEVELS = 10_000
UPLOAD_CM1_MAX_LEVELS = 2_000  # SounderPy's reader converts level by level, which is slow
UPLOAD_MIN_LEVELS = 10
UPLOAD_DEFAULT_TITLE = "Custom Sounding"
UPLOAD_PLOT_LEVELS = 150  # SounderPy's max_levels for uploads (its own default, 250, for everything else)
UPLOAD_LIMITS_PER_IP = ((60, 5), (3600, 30))  # (seconds, requests)
UPLOAD_LIMIT_TOTAL = (3600, 120)
UPLOAD_MAX_PENDING = 2  # plots waiting or drawing, so uploads can't crowd out the other data sources
UPLOAD_PENDING = threading.BoundedSemaphore(UPLOAD_MAX_PENDING)
UPLOAD_HITS_LOCK = threading.Lock()
UPLOAD_HITS = defaultdict(deque)

# Letters and numbers in any language plus basic punctuation. Leaving out $ and \ also keeps
# Matplotlib from reading a label as math, and < > & keep it inert if it's ever shown as HTML.
UPLOAD_TEXT = re.compile(r"[\w .,:;'()/#+|\-]*")

# name: (lowest, highest), matching the columns of a SHARPpy file.
UPLOAD_COLUMNS = {
    "pressure": (1.0, 1100.0),  # hPa
    "height": (-500.0, 60000.0),  # m
    "temperature": (-120.0, 70.0),  # C
    "dewpoint": (-150.0, 70.0),  # C
    "wind direction": (0.0, 360.0),  # degrees
    "wind speed": (0.0, 300.0),  # kt
}


# name: (lowest, highest), matching the columns of a CM1 input_sounding file.
UPLOAD_CM1_COLUMNS = {
    "height": (0.0, 60000.0),  # m above ground
    "potential temperature": (150.0, 5000.0),  # K
    "mixing ratio": (0.0, 100.0),  # g/kg
    "u wind": (-200.0, 200.0),  # m/s
    "v wind": (-200.0, 200.0),  # m/s
}


# SounderPy picks the map inset's satellite detail to suit its size, so a plot with the map peaks near 0.5 GB
# at any zoom or latitude (measured with 3.3.0: zoom 4 and 8 at 35N and 53N).
MAX_MAP_ZOOM = 4


# -----------------------------------------------------------------------------
# REQUEST MODELS
# -----------------------------------------------------------------------------

# A named storm motion, or [direction (degrees), speed (kt)].
StormMotion = Union[
    Literal["right_moving", "left_moving", "mean_wind"],
    Annotated[list[Annotated[FiniteFloat, Field(ge=0, le=360)]], Field(min_length=2, max_length=2)],
]


class SurfaceMods(BaseModel, extra="forbid"):
    """SounderPy's modify_sfc."""
    T: Optional[Annotated[FiniteFloat, Field(ge=-120, le=70)]] = None
    Td: Optional[Annotated[FiniteFloat, Field(ge=-150, le=70)]] = None
    ws: Optional[Annotated[FiniteFloat, Field(ge=0, le=300)]] = None
    wd: Optional[Annotated[FiniteFloat, Field(ge=0, le=360)]] = None
    method: Optional[Literal["mix", "replace", "blend"]] = None
    depth: Optional[Annotated[FiniteFloat, Field(gt=0, le=5000)]] = None  # m AGL, blend only


class Settings(BaseModel):
    """Figure settings, for both data-source and uploaded soundings."""
    color_blind: bool = True
    dark_mode: bool = False
    hodo: bool = False
    sr_hodo: bool = False
    storm_motion: StormMotion = "right_moving"
    modify_sfc: Optional[SurfaceMods] = None
    winter: bool = False  # SounderPy's winter sounding
    ylim_top: Optional[Literal[500]] = None  # 500: show the skew-t from 1050 to 500 hPa (see LOW_LEVEL_YLIM)
    ecape: bool = False
    map_zoom: int = Field(default=0, ge=0, le=MAX_MAP_ZOOM)
    radar: Optional[Literal["single-site", "mosaic"]] = None
    radar_time: Optional[dt.datetime] = None  # UTC; defaults to the sounding's date and time
    hodo_boundary_angle: Optional[Annotated[FiniteFloat, Field(ge=0, le=360)]] = None


class SoundingRequest(BaseModel):
    source: Literal["raob", "acars", "bufkit", "reanalysis"]
    output: Literal["png", "csv", "cm1", "sharppy"] = "png"
    settings: Settings = Field(default_factory=Settings)

    # RAOB: site + date + hour. ACARS: profile + date + hour.
    # BUFKIT: model + site + fcst_hr (+ optional run date/hour).
    # Reanalysis: lat + lon + date + hour.
    site: Optional[str] = None
    profile: Optional[str] = None
    model: Optional[str] = None
    fcst_hr: Optional[int] = None
    lat: Optional[Annotated[FiniteFloat, Field(ge=-90, le=90)]] = None
    lon: Optional[Annotated[FiniteFloat, Field(ge=-180, le=180)]] = None
    date: Optional[dt.date] = None
    hour: Optional[str] = None

    @field_validator("hour")
    @classmethod
    def utc_hour(cls, value):
        """'7' or '07' -> '07'. Blank means no hour (a BUFKIT run left as the latest)."""
        if value is None or not value.strip():
            return None
        if not re.fullmatch(r"\d{1,2}", value.strip()) or int(value) > 23:
            raise ValueError("hour must be a UTC hour from 0 to 23")
        return f"{int(value):02d}"


MAX_COMPOSITE_PROFILES = 6
COMPOSITE_FETCH_WORKERS = 4  # fetched side by side; drawing still takes turns under PLOT_LOCK
ACARS_FETCH_WORKERS = 6  # an airport search lists all 24 hours, a few at a time


class CompositeSettings(BaseModel):
    """Names match SounderPy's build_composite. The style lists hold one entry per profile."""
    dark_mode: bool = True
    shade_between: bool = True
    cmap: Literal["viridis", "plasma", "cividis", "turbo", "coolwarm"] = "viridis"
    colors_to_use: Optional[list[str]] = None
    ls_to_use: Optional[list[Literal["-", "--", ":", "-."]]] = None
    lw_to_use: Optional[list[float]] = None
    alphas_to_use: Optional[list[float]] = None
    # Which panels, a storm-relative hodograph, the parameter table, and the storm motion.
    style: Literal["full", "sounding", "hodograph"] = "full"
    sr_hodo: bool = False
    show_params: bool = True
    storm_motion: StormMotion = "right_moving"


class CompositeRequest(BaseModel):
    profiles: list[SoundingRequest]
    settings: CompositeSettings = Field(default_factory=CompositeSettings)


class UploadCm1(BaseModel):
    surface_pressure: Annotated[FiniteFloat, Field(ge=300, le=1100)]  # hPa
    surface_theta: Annotated[FiniteFloat, Field(ge=150, le=500)]  # K
    surface_qv: Annotated[FiniteFloat, Field(ge=0, le=100)]  # g/kg
    rows: list[tuple[FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat]] = Field(max_length=UPLOAD_CM1_MAX_LEVELS)
    elevation: Optional[Annotated[FiniteFloat, Field(ge=-500, le=9000)]] = None  # m; CM1 files don't say


class UploadRequest(BaseModel):
    title: str = Field(default="", max_length=50)
    location: str = Field(default="", max_length=30)
    right_title: str = Field(default="", max_length=30)
    date: dt.date
    time: dt.time
    lat: Annotated[FiniteFloat, Field(ge=-90, le=90)]  # temperature advection and the map need these
    lon: Annotated[FiniteFloat, Field(ge=-180, le=180)]
    rows: Optional[list[tuple[FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat]]] = Field(default=None, max_length=UPLOAD_MAX_LEVELS)
    cm1: Optional[UploadCm1] = None
    settings: Settings = Field(default_factory=Settings)

    @field_validator("title", "location", "right_title")
    @classmethod
    def plain_text(cls, value):
        value = value.strip()
        if not UPLOAD_TEXT.fullmatch(value):
            raise ValueError("unsupported characters")
        return value

    @model_validator(mode="after")
    def one_sounding(self):
        if (self.rows is None) == (self.cm1 is None):
            raise ValueError("send one sounding")
        return self


# -----------------------------------------------------------------------------
# HELPERS
# -----------------------------------------------------------------------------

UNKNOWN_AIRPORT = {"airport": "Unknown Airport", "lat": None, "lon": None}
AIRPORTS_LOCK = threading.Lock()
AIRPORTS = {"table": None, "next_try": 0.0}


def _airport_table(text):
    """{IATA code: {airport, lat, lon}} from SounderPy's airport list. The first row for a code wins."""
    df = pd.read_csv(io.StringIO(text), skiprows=7, skipinitialspace=True)
    table = {}
    for code, name, city, lat, lon in zip(df["IATA"].astype(str).str.strip().str.upper(),
                                          df["Name"], df["City"], df["Latitude"], df["Longitude"]):
        table.setdefault(code, {"airport": f"{name}, {city}", "lat": round(float(lat), 3), "lon": round(float(lon), 3)})
    return table


def _airports():
    """The airport table, downloaded once per process. If GitHub can't be reached, the last saved copy
    is used, and the download is tried again every AIRPORTS_RETRY_SECONDS rather than on every lookup."""
    with AIRPORTS_LOCK:
        if AIRPORTS["table"] is None and time.time() >= AIRPORTS["next_try"]:
            try:
                response = requests.get(AIRPORTS_CSV_URL, timeout=15)
                response.raise_for_status()
                AIRPORTS["table"] = _airport_table(response.text)
                AIRPORTS_FILE.write_text(response.text)
            except Exception:
                LOGGER.exception("Unable to download the airports list")
                AIRPORTS["next_try"] = time.time() + AIRPORTS_RETRY_SECONDS
                if AIRPORTS_FILE.exists():
                    AIRPORTS["table"] = _airport_table(AIRPORTS_FILE.read_text())
        return AIRPORTS["table"] or {}


def _airport_info(iata):
    """Name and coordinates for an airport code (coordinates may be None)."""
    return _airports().get(str(iata).strip().upper(), UNKNOWN_AIRPORT)


def _ymd(day):
    return day.strftime("%Y"), day.strftime("%m"), day.strftime("%d")


def _hour(value):
    return f"{int(value):02d}"


def _require(req, *fields):
    missing = [name for name in fields if getattr(req, name) in (None, "")]
    if missing:
        raise HTTPException(422, f"Missing required field(s): {', '.join(missing)}")


def _site_label(clean_data, descriptor):
    info = clean_data["site_info"]
    valid = info["valid-time"]
    return (
        f"{valid[3]}Z {descriptor} "
        f"{info['site-id']}, {info['site-name']} at "
        f"{valid[1]}-{valid[2]}-{valid[0]}"
    )


def _iso_time(parts):
    """['2026', '10', '29', '13'] or [..., '05:59'] -> '2026-10-29T13:00Z'."""
    try:
        year, month, day, hour = (str(p) for p in parts)
        hh, _, mm = hour.partition(":")
        return f"{year}-{month}-{day}T{int(hh):02d}:{int(mm or 0):02d}Z"
    except (TypeError, ValueError):
        return None


def _plain(value):
    """Convert numpy scalars to JSON-friendly Python values."""
    return value.item() if hasattr(value, "item") else value


def _sounding_info(clean_data, source):
    """Structured details the front end uses to caption the plot."""
    info = clean_data["site_info"]
    lat, lon = (round(float(v), 2) for v in info["site-latlon"])
    model = info.get("model")
    fcst = info.get("fcst-hour")

    try:
        elevation = round(float(info.get("site-elv")))
    except (TypeError, ValueError):
        elevation = None

    return {
        "source": source,
        "site_id": str(_plain(info.get("site-id")) or "").strip() or None,
        "site_name": str(info.get("site-name") or "").strip() or None,
        "location": str(info.get("site-lctn") or "").strip() or None,
        "lat": lat,
        "lon": lon,
        "elevation_m": elevation,
        "model": model if model and model != "no-model" else None,
        "fcst_hour": fcst if fcst and fcst != "no-fcst-hour" else None,
        "run_time": _iso_time(info.get("run-time")),
        "valid_time": _iso_time(info.get("valid-time")),
    }


# Who serves each data source, for "isn't responding" messages.
PROVIDERS = {
    "raob": "The University of Wyoming upper-air archive",
    "acars": "The OU SHARP aircraft-data archive",
    "bufkit": "The BUFKIT data server",
    "reanalysis": "NOAA NCEI's reanalysis archive",
}


IGRA_PROVIDER = "NOAA's IGRAv2 archive"


def _is_igra(site):
    """SounderPy fetches 11-character IDs ('USM00072357') from IGRAv2, and the rest from Wyoming."""
    return len((site or "").strip()) == 11


def _provider(req):
    return IGRA_PROVIDER if req.source == "raob" and _is_igra(req.site) else PROVIDERS[req.source]


def _station_record(site, day):
    """' Its IGRAv2 record runs 1957–1961.' when the date is outside the station's record, else ''."""
    if not day:
        return ""
    try:
        row = find_raob_station(site)
        first, last = int(row["IGRA_FIRST_YEAR"]), int(row["IGRA_LAST_YEAR"])
    except (ValueError, KeyError):
        return ""
    return f" Its IGRAv2 record runs {first}–{last}." if not first <= day.year <= last else ""


def _when(req):
    """'12Z on Oct 29, 2026', or '' when there's no date/hour."""
    if not req.date or req.hour in (None, ""):
        return ""
    return f"{_hour(req.hour)}Z on {req.date:%b} {req.date.day}, {req.date.year}"


def _friendly_error(req, exc):
    """Turn a SounderPy or data-source failure into a message a user can act on."""
    text = " ".join(str(exc).split())
    lower = text.lower()
    when = _when(req)

    unreachable = isinstance(exc, (requests.Timeout, requests.ConnectionError)) or any(
        phrase in lower for phrase in ("could not be reached", "temporarily unavailable", "currently returning http",
                                       "unavailable right now"))
    if unreachable:
        return f"{_provider(req)} isn't responding right now. This is usually temporary, so please try again in a few minutes."

    if req.source == "raob":
        site = req.site.strip().upper()
        if "station list" in lower:
            return (f"“{site}” isn't a known upper-air station. Click a station on the map, or use its ICAO, WMO, or "
                    "IGRAv2 ID (e.g. OAX, KOAX, 72558, or USM00072558).")
        if "no wmo or icao id" in lower:
            igra = re.search(r"'([A-Z0-9]{11})'", text)
            return f"{site} can only be fetched from IGRAv2" + (f": use its IGRAv2 ID, {igra.group(1)}." if igra else ", by its IGRAv2 ID.")
        record = _station_record(site, req.date)
        if _is_igra(site):
            return f"No IGRAv2 sounding for {site} at {when}.{record} Try another date or time; many stations launched only at 00Z and 12Z."
        return (f"No observed sounding for {site} at {when}.{record} Most stations launch only at 00Z and 12Z, new soundings "
                "can take an hour or two to appear, and older dates may only be in IGRAv2 (pick the station's IGRAv2 ID on the map).")

    if req.source == "bufkit":
        site, model = req.site.strip().upper(), req.model.upper()
        if "doesn't seem to exist" in lower:
            return f"“{site}” isn't a BUFKIT site. Click a station on the map to pick one."
        if "invalid forecast hour" in lower:
            limit = re.search(r"up to F0*(\d+)", text)
            return f"Forecast hour {req.fcst_hr} is beyond the {model}'s range" + (f" (up to F{int(limit.group(1)):02d})." if limit else ".")
        if "not a valid model" in lower:
            return f"The {model} isn't available for past runs. Try the GFS, RRFS, RAP, HRRR, NAM, or NAMNEST, or leave the run blank for the latest."
        run = f"the {when} run" if when else "the latest run"
        return (f"No {model} forecast for {site} at F{int(req.fcst_hr):02d} from {run}. Try another forecast hour, model, "
                "or run; past runs are only archived for some models and dates.")

    if req.source == "acars":
        if "does not exist" in lower or "invalid profile" in lower:
            return f"Flight profile {req.profile} isn't available for {when}. Search for flights again and pick one from the list."
        return f"Flight profile {req.profile} couldn't be loaded. It may be incomplete; try another flight or time."

    return (f"No RAP/RUC reanalysis for {req.lat:.2f}, {req.lon:.2f} at {when}. The point must be over North America, "
            "and NOAA NCEI's archive has gaps for some dates, so try a nearby hour or date.")


def _load_data(req):
    """Fetch SounderPy data for a request. Returns (clean_data, label)."""
    if req.source == "raob":
        _require(req, "site", "date", "hour")
        clean_data = spy.get_obs_data(
            req.site.strip().upper(), *_ymd(req.date), _hour(req.hour),
            hush=True,
        )
        return clean_data, _site_label(clean_data, "RAOB for")

    if req.source == "acars":
        _require(req, "profile", "date", "hour")
        clean_data = spy.acars_data(
            *_ymd(req.date), _hour(req.hour)
        ).get_profile(req.profile.strip())
        return clean_data, _site_label(clean_data, "flight from")

    if req.source == "bufkit":
        _require(req, "model", "site", "fcst_hr")
        run = ()
        if req.date and req.hour not in (None, ""):
            run = (*_ymd(req.date), _hour(req.hour))
        model = req.model.lower()
        if model in BUFKIT_RETIRED_MODELS:
            raise HTTPException(422, f"The {req.model.upper()} was retired on Nov 3, 2026, when the RRFS replaced it, and its runs "
                                     "weren't archived. Choose the RRFS instead.")
        if model not in BUFKIT_MODELS + BUFKIT_ARCHIVE_MODELS:
            raise HTTPException(422, f"“{req.model}” isn't a BUFKIT model. Choose one from the list.")
        if not run and model not in BUFKIT_MODELS:
            raise HTTPException(422, f"The {req.model.upper()} has been replaced by the RRFS, so only its past runs are available. "
                                     "Enter a run date and hour, or choose the RRFS for the latest forecast.")
        site = req.site.strip().upper()
        if site in BUFKIT_RETIRED:
            raise HTTPException(422, f"“{site}” no longer has BUFKIT data. Click a station on the map to pick a nearby one.")
        site = BUFKIT_RENAMED.get(site, site)
        if model == "gfs" and not run:
            site = BUFKIT_GFS_LATEST.get(site, site)
        clean_data = spy.get_bufkit_data(
            req.model.lower(), site.lower(), int(req.fcst_hr), *run,
            hush=True,
        )
        return clean_data, _site_label(clean_data, "forecast for")

    _require(req, "lat", "lon", "date", "hour")
    clean_data = spy.get_model_data(
        "rap-ruc", [req.lat, req.lon], *_ymd(req.date), _hour(req.hour),
        hush=True,
    )
    info = clean_data["site_info"]
    valid = info["valid-time"]
    label = (
        f"{valid[3]}Z reanalysis for {info['site-latlon']} at "
        f"{valid[1]}-{valid[2]}-{valid[0]}"
    )
    return clean_data, label


def _cache_key(req):
    """Everything that decides which profile a request gets. Plot settings don't, so they share an entry."""
    return (
        SOUNDERPY_VERSION,
        req.source,
        (req.site or "").strip().upper(),
        (req.profile or "").strip(),
        (req.model or "").lower(),
        req.fcst_hr,
        req.lat,
        req.lon,
        req.date.isoformat() if req.date else None,
        _hour(req.hour) if req.hour not in (None, "") else None,
    )


def _cache_ttl(req):
    """Seconds to keep a profile, or None for a fixed past profile that won't change."""
    if not (req.date and req.hour not in (None, "")):
        return PROFILE_CACHE_LATEST_SECONDS
    if req.date >= dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=2):
        return PROFILE_CACHE_RECENT_SECONDS
    return None


def _describe(req):
    """The fields a request actually set, for the log."""
    fields = req.model_dump(include={"site", "profile", "model", "fcst_hr", "lat", "lon", "date", "hour"})
    return " ".join(f"{name}={value}" for name, value in fields.items() if value not in (None, ""))


def _fetch_data(req, use_cache=True):
    """_load_data through the profile cache. Returns (clean_data, label).

    A cache problem is never a request problem: it's logged, and the data comes from the source.
    """
    started = time.time()
    key = _cache_key(req)
    cacheable = req.source not in PROFILE_CACHE_SKIP_SOURCES

    if use_cache and cacheable:
        try:
            cached = PROFILE_CACHE.get(key)
        except Exception:
            LOGGER.exception("Profile cache read failed")
            cached = None
        if cached is not None:
            LOGGER.info("fetch %s %s data=cache fetch=%.2fs", req.source, _describe(req), time.time() - started)
            return cached

    result = _load_data(req)
    LOGGER.info("fetch %s %s data=source fetch=%.2fs", req.source, _describe(req), time.time() - started)

    if cacheable:
        try:
            PROFILE_CACHE.set(key, result, expire=_cache_ttl(req))
        except Exception:
            LOGGER.exception("Profile cache write failed")
    return result


def _modify_sfc(mods):
    """SounderPy's modify_sfc dict, or None when no surface value changes."""
    if not mods:
        return None
    values = mods.model_dump(include={"T", "Td", "ws", "wd"}, exclude_none=True)
    if not values:
        return None
    if mods.method:
        values["method"] = mods.method
        if mods.method == "blend" and mods.depth is not None:
            values["depth"] = mods.depth
    return values


# The skew-t's low-level view, (bottom, top) in hPa.
LOW_LEVEL_YLIM = (1050, 500)


def _web_note(message):
    """A SounderPy figure warning in the page's words: no Python or CLI hints like "(radar='single', ...)"."""
    text = re.sub(r"\s*\([^)]*(?:radar=|CLI)[^)]*\)", "", " ".join(str(message).split()))
    text = text.replace("Use the nearest NEXRAD site", "Choose the NEXRAD site radar")
    return text if text.endswith(".") else text + "."


def _render_png(clean_data, s, max_levels=None):
    """Render a sounding or hodograph. Returns (PNG bytes, notes): notes are SounderPy's warnings about
    the figure, such as radar that couldn't be drawn, for the page to show. max_levels overrides
    SounderPy's default level limit."""
    storm_motion = s.storm_motion
    if isinstance(storm_motion, list):
        storm_motion = [int(v) for v in storm_motion]

    common = dict(
        dark_mode=s.dark_mode,
        storm_motion=storm_motion,
        modify_sfc=_modify_sfc(s.modify_sfc),  # None, not False: SounderPy reads False as a dict
        radar=s.radar,
        radar_time=s.radar_time.replace(tzinfo=None) if s.radar_time else "sounding",
        map_zoom=s.map_zoom,
        hodo_boundary=(
            {"angle": [s.hodo_boundary_angle], "color": ["brown"]}
            if s.hodo_boundary_angle is not None
            else None
        ),
        save=True,
    )
    if max_levels:
        common["max_levels"] = max_levels

    with TemporaryDirectory(prefix="sounderpy_plot_") as tmpdir:
        output = Path(tmpdir) / "plot.png"

        with PLOT_LOCK, warnings.catch_warnings(record=True) as caught:
            # warnings' filters are process-wide, which is fine here: plotting takes turns under PLOT_LOCK
            warnings.simplefilter("always")
            try:
                if s.hodo:
                    spy.build_hodograph(clean_data, sr_hodo=s.sr_hodo, filename=str(output), **common)
                else:
                    kwargs = dict(common, color_blind=s.color_blind, filename=str(output))
                    if s.ylim_top:
                        kwargs["ylim"] = LOW_LEVEL_YLIM
                    if s.winter:
                        # The winter sounding has no ECAPE parcels, storm-relative hodograph, or boundary
                        # line, and warns when they're set, so they're left at their defaults.
                        kwargs.update(mode="winter", hodo_boundary=None)
                    else:
                        kwargs.update(special_parcels=None if s.ecape else "simple", sr_hodo=s.sr_hodo)
                    spy.build_sounding(clean_data, **kwargs)
            finally:
                plt.close("all")

        # SounderPy's figure warnings, plus its parcel warnings (plain Warnings), e.g. no most-unstable parcel
        # for an old sounding without dewpoints.
        notes = list(dict.fromkeys(_web_note(w.message) for w in caught if issubclass(w.category, SounderPyWarning)
                                   or "parcel could not be computed" in str(w.message)))
        return output.read_bytes(), notes


def _render_composite(data_list, s):
    """Render a composite of several profiles and return the PNG bytes."""
    with TemporaryDirectory(prefix="sounderpy_composite_") as tmpdir:
        output = Path(tmpdir) / "composite.png"

        with PLOT_LOCK:
            try:
                spy.build_composite(
                    data_list,
                    shade_between=s.shade_between,
                    cmap=s.cmap,
                    dark_mode=s.dark_mode,
                    colors=s.colors_to_use,
                    linestyles=s.ls_to_use,
                    linewidths=s.lw_to_use,
                    alphas=s.alphas_to_use,
                    style=s.style,
                    sr_hodo=s.sr_hodo,
                    show_params=s.show_params,
                    storm_motion=s.storm_motion,
                    save=True,
                    filename=str(output),
                )
            finally:
                plt.close("all")

        return output.read_bytes()


def _check_composite(req):
    count = len(req.profiles)
    if not 2 <= count <= MAX_COMPOSITE_PROFILES:
        raise HTTPException(422, f"A composite needs 2 to {MAX_COMPOSITE_PROFILES} profiles; this request has {count}.")

    s = req.settings
    for values in (s.colors_to_use, s.ls_to_use, s.lw_to_use, s.alphas_to_use):
        if values is not None and len(values) != count:
            raise HTTPException(422, "Each line style list needs one entry per profile.")
    if s.colors_to_use and not all(re.fullmatch(r"#[0-9a-fA-F]{6}", c) for c in s.colors_to_use):
        raise HTTPException(422, "Line colors must be hex values like #e8c468.")
    if s.lw_to_use and not all(0.5 <= w <= 10 for w in s.lw_to_use):
        raise HTTPException(422, "Line widths must be between 0.5 and 10.")
    if s.alphas_to_use and not all(0 < a <= 1 for a in s.alphas_to_use):
        raise HTTPException(422, "Line opacity must be between 0 and 1.")


def _export_file(clean_data, file_type):
    """Export SounderPy data to text. Returns (bytes, filename, content type)."""
    suffix, content_type = EXPORTS[file_type]

    with TemporaryDirectory(prefix="sounderpy_export_") as tmpdir:
        output = Path(tmpdir) / f"sounderpy_data{suffix}"
        spy.to_file(file_type, clean_data, filename=str(output))
        return output.read_bytes(), output.name, content_type


def _check_upload_rate(ip):
    """Raise 429 past a limit. Failed attempts count too. Lives in memory, which suits the single worker."""
    now = time.time()
    window, total = UPLOAD_LIMIT_TOTAL
    longest = max(seconds for seconds, _ in UPLOAD_LIMITS_PER_IP)

    def retry(hits, seconds):
        wait = int(seconds - (now - next(h for h in hits if now - h < seconds))) + 1
        minutes = max(1, round(wait / 60))
        raise HTTPException(
            429,
            f"That's a lot of uploads in a short time. Please try again in about {minutes} minute{'' if minutes == 1 else 's'}.",
            headers={"Retry-After": str(wait)},
        )

    with UPLOAD_HITS_LOCK:
        for key in list(UPLOAD_HITS):
            hits = UPLOAD_HITS[key]
            while hits and now - hits[0] >= (window if key is None else longest):
                hits.popleft()
            if not hits:
                del UPLOAD_HITS[key]

        everyone, mine = UPLOAD_HITS[None], UPLOAD_HITS[ip]
        for seconds, limit in UPLOAD_LIMITS_PER_IP:
            if sum(now - h < seconds for h in mine) >= limit:
                retry(mine, seconds)
        if len(everyone) >= total:
            retry(everyone, window)
        mine.append(now)
        everyone.append(now)


async def _read_upload_body(request):
    """Read at most the size limit, whatever Content-Length claims."""
    too_large = HTTPException(413, "That sounding is too large. The limit is 1 MB.")
    try:
        if int(request.headers.get("content-length", 0)) > UPLOAD_MAX_BODY_BYTES:
            raise too_large
    except ValueError:
        raise HTTPException(400, "Bad request.")

    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > UPLOAD_MAX_BODY_BYTES:
            raise too_large
    return bytes(body)


def _upload_problem(exc):
    """A validation failure as a sentence. Never echoes what was sent."""
    error = exc.errors()[0]
    if error["type"] == "json_invalid":
        return "The sounding couldn't be read. Choose the file again."
    field = str(error["loc"][0]) if error["loc"] else ""
    return {
        "title": "Keep the main title to 50 characters, using letters, numbers and basic punctuation.",
        "location": "Keep the location name to 30 characters, using letters, numbers and basic punctuation.",
        "right_title": "The filename can't be used as a title. Untick that box and try again.",
        "date": "Enter a valid date.",
        "time": "Enter a valid UTC time.",
        "lat": "Latitude must be between -90 and 90.",
        "lon": "Longitude must be between -180 and 180.",
        "rows": f"The sounding must have at most {UPLOAD_MAX_LEVELS:,} levels of six finite numbers.",
        "cm1": f"This CM1 sounding has a value that can't be right, or more than {UPLOAD_CM1_MAX_LEVELS:,} levels. Check the file, and that any surface elevation is in meters.",
        "settings": "One of the figure settings isn't valid for an uploaded sounding.",
    }.get(field, "The sounding couldn't be read. Choose the file again.")


def _check_columns(rows, columns):
    """Refuse values outside each column's range. Written so that NaN fails too."""
    for column, (name, (low, high)) in enumerate(columns.items()):
        bad = np.flatnonzero(~((rows[:, column] >= low) & (rows[:, column] <= high)))
        if bad.size:
            raise HTTPException(422, f"Level {bad[0] + 1} has an impossible {name}. Check the file's columns and units.")


def _cm1_rows(cm1):
    """A CM1 sounding as SHARPpy-style rows (p, z, T, Td, wd, ws), converted by SounderPy's own reader.

    The reader only takes a path, so the checked numbers are written out for it; the temporary
    file holds nothing but those numbers and is gone straight after.
    """
    rows = np.array(cm1.rows, dtype=float).reshape(-1, 5)
    _check_columns(rows, UPLOAD_CM1_COLUMNS)
    if len(rows) < UPLOAD_MIN_LEVELS + 2:  # the reader leaves off the top two levels
        raise HTTPException(422, f"The sounding needs at least {UPLOAD_MIN_LEVELS + 2} levels; this one has {len(rows)}.")
    if np.any(np.diff(rows[:, 0]) <= 0):
        raise HTTPException(422, "The heights in this CM1 file must rise from each level to the next.")

    with TemporaryDirectory(prefix="sounderpy_cm1_") as tmpdir:
        path = Path(tmpdir) / "input_sounding"
        with open(path, "w") as f:
            f.write(f"{cm1.surface_pressure:.6f} {cm1.surface_theta:.6f} {cm1.surface_qv:.6f}\n")
            np.savetxt(f, rows, fmt="%.6f")
        data = spy.from_cm1(str(path), {
            "elev": cm1.elevation, "latlon": [0.0, 0.0], "top_title": "", "left_title": "", "right_title": "",
        })

    # Bone-dry levels have no real dewpoint. The reader marks those -80 C, which can be warmer
    # than the air itself way up high, so keep them below the temperature there.
    T = data["T"].m.astype(float)
    Td = data["Td"].m.astype(float)
    dry = ~(Td >= -150) | (Td == -80)
    Td[dry] = np.minimum(-80.0, T[dry] - 10)
    return np.c_[
        data["p"].m, data["z"].m, T, Td,
        mpcalc.wind_direction(data["u"], data["v"]).m, mpcalc.wind_speed(data["u"], data["v"]).m,
    ].astype(float)


def _check_upload_levels(req, rows):
    """Returns the rows as an array, keeping each level that's higher than every one before it.

    Sonde pressures repeat and jitter, and a file can run on into the descent, so those levels are
    dropped. Values that can't be real are refused instead, since they mean a bad file.
    """
    today = dt.datetime.now(dt.timezone.utc).date()
    if not dt.date(1900, 1, 1) <= req.date <= today + dt.timedelta(days=1):
        raise HTTPException(422, "Enter a date from 1900 up to today.")

    rows = np.array(rows, dtype=float).reshape(-1, 6)
    _check_columns(rows, UPLOAD_COLUMNS)

    bad = np.flatnonzero(rows[:, 3] > rows[:, 2] + 0.5)
    if bad.size:
        raise HTTPException(422, f"Level {bad[0] + 1} has a dewpoint above its temperature. Check the file's columns.")

    keep, lowest_p, highest_z = [], np.inf, -np.inf
    for i, (p, z) in enumerate(rows[:, :2]):
        if p < lowest_p and z > highest_z:
            keep.append(i)
            lowest_p, highest_z = p, z
    if len(keep) < UPLOAD_MIN_LEVELS:
        raise HTTPException(422, f"The sounding needs at least {UPLOAD_MIN_LEVELS} levels that rise with height; this one has {len(keep)}.")
    return rows[keep]


def _upload_label(req):
    return req.title or UPLOAD_DEFAULT_TITLE


def _upload_clean_data(req, rows):
    """The dict SounderPy plots, labelled so a plot can't pass as official data."""
    p, z, T, Td, wd, ws = rows.T
    u, v = mpcalc.wind_components(ws * units.kts, wd * units.degrees)
    place = " | ".join(filter(None, [req.location, f"{req.lat:.2f}, {req.lon:.2f}"]))
    return {
        "p": p * units.hPa,
        "z": z * units.m,
        "T": T * units.degC,
        "Td": Td * units.degC,
        "u": u,
        "v": v,
        "site_info": {
            "site-id": _upload_label(req),
            "site-name": _upload_label(req),
            "site-lctn": req.location,
            "site-latlon": [req.lat, req.lon],
            "site-elv": float(z[0]),
            "source": "USER-SUPPLIED PROFILE",
            "model": "no-model",
            "fcst-hour": "no-fcst-hour",
            "run-time": ["none", "none", "none", "none"],
            "valid-time": [f"{req.date:%Y}", f"{req.date:%m}", f"{req.date:%d}", f"{req.time:%H%M}"],
        },
        "titles": {
            "top_title": _upload_label(req),
            "left_title": f"VALID: {req.date:%m-%d-%Y} {req.time:%H%M}Z | {place}",
            "right_title": f"{req.right_title or UPLOAD_DEFAULT_TITLE}    ",
        },
    }


def _plot_upload(req):
    if not UPLOAD_PENDING.acquire(blocking=False):
        raise HTTPException(503, "The server is busy with other uploads. Please try again in a moment.", headers={"Retry-After": "30"})

    started = time.time()
    try:
        received = len(req.cm1.rows) if req.cm1 else len(req.rows)
        try:
            source = _cm1_rows(req.cm1) if req.cm1 else req.rows
        except HTTPException:
            raise
        except (Exception, SystemExit) as exc:  # SounderPy's reader; logged without the data, as below
            LOGGER.error("CM1 upload of %d levels failed to convert: %s", received, type(exc).__name__)
            raise HTTPException(422, "This CM1 sounding couldn't be converted. Check the file's columns and units.")
        rows = _check_upload_levels(req, source)
        plotted = min(len(rows), UPLOAD_PLOT_LEVELS)
        settings = req.settings
        if settings.radar and not settings.map_zoom:  # radar is drawn on the map
            settings = settings.model_copy(update={"map_zoom": 2})
        try:
            png, notes = _render_png(_upload_clean_data(req, rows), settings, max_levels=UPLOAD_PLOT_LEVELS)
        # Logged without the traceback's locals or any of the data: it may be unpublished.
        except (Exception, SystemExit) as exc:
            LOGGER.error("upload of %d levels failed to draw: %s", len(rows), type(exc).__name__)
            raise HTTPException(
                500,
                "SounderPy couldn't draw this sounding. That can happen with a very short or incomplete profile; "
                "try turning off ECAPE or surface edits, or check the file.",
            )
    finally:
        UPLOAD_PENDING.release()

    LOGGER.info("upload %s levels=%d/%d/%d served in %.1fs", "cm1" if req.cm1 else "sharppy", received, len(rows), plotted, time.time() - started)
    return {
        "label": _upload_label(req),
        "info": None,
        "levels": {"received": received, "plotted": plotted},
        "notes": notes,
        "image": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
    }


LATEST_RUN_STATION_NUM = 253  # KMOP's NCEP station number (NUM in SounderPy's BUFKIT station list)


def _newer_nomads_rrfs(psu_run):
    """The newest RRFS run on NOMADS that's newer than Penn State's, or None. Checks file headers only."""
    run = ncep_bufr.latest_expected_rrfs_run()
    for _ in range(8):  # NOMADS keeps about two days
        if psu_run is not None and run <= psu_run:
            return None
        try:
            if requests.head(ncep_bufr.nomads_rrfs_url(LATEST_RUN_STATION_NUM, run), timeout=10).ok:
                return run
        except requests.RequestException:
            LOGGER.warning("NOMADS RRFS check failed for %s", run)
            return None
        run -= dt.timedelta(hours=ncep_bufr.RRFS_SOUNDING_CYCLES)
    return None


def _latest_run(model, station="KMOP"):
    """{model, latest_run} for one BUFKIT model, from the header of a Penn State file."""
    model3 = "gfs3" if model == "gfs" else model
    data_url = f"http://www.meteo.psu.edu/bufkit/data/{model.upper()}/{model3}_{station.lower()}.buf"

    try:
        response = requests.get(data_url, timeout=10)
        response.raise_for_status()
        lines = response.text.splitlines()

        if len(lines) < 5 or "TIME" not in lines[4]:
            raise ValueError("BUFKIT header does not contain expected TIME field")

        run_line = lines[4]
        start = run_line.index("TIME") + 7
        run_time = run_line[start:start + 11]  # YYMMDD/HHMM
        latest = dt.datetime(2000 + int(run_time[0:2]), int(run_time[2:4]), int(run_time[4:6]), int(run_time[7:9]))

    except Exception:
        LOGGER.exception("Unable to determine latest %s BUFKIT run", model)
        latest = None

    # SounderPy uses NOMADS's RRFS run when Penn State's is older, so the label should say so too.
    if model == "rrfs":
        latest = _newer_nomads_rrfs(latest) or latest

    return {"model": model, "latest_run": f"{latest:%m/%d %H}Z" if latest else None}


def _fetch_latest_runs():
    """The latest run of each BUFKIT model, all checked at once."""
    with ThreadPoolExecutor(max_workers=len(BUFKIT_MODELS)) as pool:
        return list(pool.map(_latest_run, BUFKIT_MODELS))


# -----------------------------------------------------------------------------
# APP
# -----------------------------------------------------------------------------

app = FastAPI(title="SounderPy Sounding Analysis API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
    expose_headers=["Content-Disposition"],
    # The UND uploader's login cookie (und.py). Origins stay an explicit list, never "*".
    allow_credentials=True,
)

# The password-protected UND sounding ops uploader. Its routes refuse everything until
# UND_PASSWORD_HASH and UND_SECRET are set (see und.py).
app.include_router(create_und_router(spy, _render_png, Settings))


@app.get("/api/health")
def health():
    return {"online": True, "sounderpy_version": SOUNDERPY_VERSION}


@app.get("/api/bufkit/latest-runs")
def latest_runs():
    with LATEST_RUN_CACHE_LOCK:
        now = time.time()
        if LATEST_RUN_CACHE["data"] is None or now >= LATEST_RUN_CACHE["expires"]:
            LATEST_RUN_CACHE["data"] = _fetch_latest_runs()
            LATEST_RUN_CACHE["expires"] = now + LATEST_RUN_CACHE_SECONDS
        return LATEST_RUN_CACHE["data"]


@app.get("/api/raob/launches/recent")
def raob_recent_launches():
    """Each launch time from the last two days with its site IDs. North America only."""
    try:
        return {"cycles": recent_launches()}
    except (requests.RequestException, KeyError, ValueError):
        LOGGER.exception("Recent launch list failed")
        raise HTTPException(502, "The launch list isn't available right now.")


@app.get("/api/raob/launches")
def raob_launches(date: dt.date = Query(...), hour: int = Query(..., ge=0, le=23)):
    """Site IDs with a sounding at this date and hour. North America only."""
    try:
        return {"date": date, "hour": hour, "stations": get_launches(date, hour)}
    except (requests.RequestException, KeyError, ValueError):
        LOGGER.exception("Launch list failed for %s %02dZ", date, hour)
        raise HTTPException(502, "The launch list isn't available right now.")


@app.get("/api/acars/profiles")
def acars_profiles(
    day: dt.date = Query(..., alias="date"),
    hour: Optional[str] = None,
    airport: Optional[str] = None,
):
    """List ACARS profiles for one hour, or for one airport across a whole day."""
    if not hour and not airport:
        raise HTTPException(422, "Provide an hour or an airport.")

    hours = [_hour(hour)] if not airport else [f"{h:02d}" for h in range(24)]
    airport = airport.strip().upper() if airport else None

    def list_hour(hour_str):
        try:
            return spy.acars_data(*_ymd(day), hour_str).list_profiles()
        except Exception:
            LOGGER.debug("No ACARS result for %s %sZ", day, hour_str, exc_info=True)
            return []

    with ThreadPoolExecutor(max_workers=ACARS_FETCH_WORKERS) as pool:
        listed = list(pool.map(list_hour, hours))

    results = []
    for hour_str, profiles in zip(hours, listed):
        for profile in profiles:
            if airport and airport not in profile:
                continue
            results.append({
                "id": profile,
                "hour": hour_str,
                "code": profile[0:3],
                **_airport_info(profile[0:3]),
            })

    return results


@app.post("/api/sounding")
def sounding(req: SoundingRequest):
    """Return a plot as JSON ({label, image}) or a data file download."""
    started = time.time()

    try:
        clean_data, label = _fetch_data(req)
    except HTTPException:
        raise
    # SounderPy calls sys.exit() for some bad inputs (e.g. a missing ACARS profile), so catch SystemExit too.
    except (Exception, SystemExit) as exc:
        LOGGER.exception("Data retrieval failed for %s", req.model_dump(exclude={"settings"}))
        raise HTTPException(502, _friendly_error(req, exc))

    drawing = time.time()
    try:
        if req.output != "png":
            content, filename, content_type = _export_file(clean_data, req.output)
            LOGGER.info("%s %s served in %.1fs draw=%.2fs", req.source, req.output, time.time() - started, time.time() - drawing)
            return Response(
                content,
                media_type=content_type,
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )

        png, notes = _render_png(clean_data, req.settings)
    except (Exception, SystemExit):
        LOGGER.exception("Rendering failed for %s", req.model_dump())
        raise HTTPException(
            500,
            "The data loaded, but SounderPy couldn't draw this plot. That can happen with very short or "
            "incomplete profiles. Try turning off ECAPE, radar, or surface edits, or pick another time.",
        )

    LOGGER.info("%s %s served in %.1fs draw=%.2fs", req.source, req.output, time.time() - started, time.time() - drawing)
    return {
        "label": label,
        "info": _sounding_info(clean_data, req.source),
        "notes": notes,
        "image": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
    }


@app.post("/api/upload-sounding")
async def upload_sounding(request: Request):
    """Plot a sounding the browser read from a user's file. Returns JSON ({label, image}). Stores nothing."""
    if not UPLOADS_ENABLED:
        raise HTTPException(503, "Uploaded soundings are turned off right now.")
    _check_upload_rate(request.client.host if request.client else "unknown")

    body = await _read_upload_body(request)
    try:
        req = UploadRequest.model_validate_json(body)
    except ValidationError as exc:
        raise HTTPException(422, _upload_problem(exc))
    return await run_in_threadpool(_plot_upload, req)


def _fetch_profiles(profiles, use_cache=True):
    """Fetch side by side. Returns (data, None) or (None, error) per profile, so failures keep their letter."""
    def fetch(profile):
        try:
            return _fetch_data(profile, use_cache)[0], None
        except HTTPException as exc:
            return None, exc.detail
        # SounderPy calls sys.exit() for some bad inputs, so catch SystemExit too.
        except (Exception, SystemExit) as exc:
            LOGGER.exception("Composite data retrieval failed for %s", profile.model_dump(exclude={"settings"}))
            return None, _friendly_error(profile, exc)

    with ThreadPoolExecutor(max_workers=COMPOSITE_FETCH_WORKERS) as pool:
        return list(pool.map(fetch, profiles))


def _settle_latest_runs(profiles, results):
    """Keep "latest run" BUFKIT profiles of one site and model on the same run.

    A new run can appear mid-fetch, which would silently mix two runs on one plot. Mixed groups are
    fetched again once. Returns (results, name of a group that's still mixed, or None).
    """
    results = list(results)
    groups = {}
    for i, profile in enumerate(profiles):
        if profile.source == "bufkit" and not (profile.date and profile.hour) and results[i][0]:
            groups.setdefault((profile.model.upper(), profile.site.strip().upper()), []).append(i)

    def mixed(indexes):
        return len({tuple(results[i][0]["site_info"]["run-time"]) for i in indexes if results[i][0]}) > 1

    for (model, site), indexes in groups.items():
        if not mixed(indexes):
            continue
        for i, result in zip(indexes, _fetch_profiles([profiles[i] for i in indexes], use_cache=False)):
            results[i] = result
        if mixed(indexes):
            return results, f"the {model} at {site}"
    return results, None


@app.post("/api/composite")
def composite(req: CompositeRequest):
    """Fetch every profile, then return one composite plot as JSON ({label, image})."""
    _check_composite(req)
    started = time.time()

    results = _fetch_profiles(req.profiles)
    results, stale = _settle_latest_runs(req.profiles, results)
    if stale:
        raise HTTPException(502, f"A new model run is arriving for {stale}, so its profiles came from different runs. Please try again in a few minutes.")

    problems = [f"Profile {chr(65 + i)}: {error}" for i, (_, error) in enumerate(results) if error]
    if problems:
        raise HTTPException(502, " ".join(problems))

    drawing = time.time()
    try:
        png = _render_composite([data for data, _ in results], req.settings)
    except HTTPException:
        raise
    except (Exception, SystemExit):
        LOGGER.exception("Composite rendering failed for %s", req.model_dump())
        raise HTTPException(500, "The data loaded, but SounderPy couldn't draw this composite. Try removing a very short or incomplete profile.")

    LOGGER.info("composite of %d served in %.1fs draw=%.2fs", len(req.profiles), time.time() - started, time.time() - drawing)
    return {
        "label": f"Composite of {len(req.profiles)} soundings",
        "info": None,
        "image": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
    }
