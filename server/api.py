"""HTTP API behind sounderpy.app: fetches sounding data and draws plots with SounderPy.

Run from this folder with:

    uvicorn api:app --host 127.0.0.1 --port 8000
"""

import base64
import io
import logging
import os
import threading
import time
import datetime as dt
from functools import lru_cache
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal, Optional, Union

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

import pandas as pd
import requests
import sounderpy as spy
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field


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

EXPORTS = {
    "csv": (".csv", "text/csv"),
    "cm1": (".snd", "text/plain"),
    "sharppy": (".txt", "text/plain"),
}

BUFKIT_MODELS = ["gfs", "nam", "namnest", "rap", "hrrr", "sref", "hiresw"]


# -----------------------------------------------------------------------------
# LOCKS / CACHES
# -----------------------------------------------------------------------------

# Retrieval is not locked. Only Matplotlib plotting is serialized.
PLOT_LOCK = threading.Lock()

LATEST_RUN_CACHE_LOCK = threading.Lock()
LATEST_RUN_CACHE = {"expires": 0.0, "data": None}
LATEST_RUN_CACHE_SECONDS = 300


# -----------------------------------------------------------------------------
# REQUEST MODELS
# -----------------------------------------------------------------------------

class Settings(BaseModel):
    color_blind: bool = True
    dark_mode: bool = False
    hodo: bool = False
    storm_motion: Union[str, list[float]] = "right_moving"
    modify_sfc: Optional[dict[str, float]] = None
    ecape: bool = False
    map_zoom: int = 2
    radar: Optional[Literal["single-site", "mosaic"]] = None
    radar_time: Optional[dt.datetime] = None  # UTC; defaults to sounding time
    hodo_boundary_angle: Optional[float] = None


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
    lat: Optional[float] = None
    lon: Optional[float] = None
    date: Optional[dt.date] = None
    hour: Optional[str] = None


# -----------------------------------------------------------------------------
# HELPERS
# -----------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _get_airports_df():
    """Load the airport metadata once per server process."""
    response = requests.get(AIRPORTS_CSV_URL, timeout=15)
    response.raise_for_status()
    return pd.read_csv(
        io.StringIO(response.text),
        skiprows=7,
        skipinitialspace=True,
    )


@lru_cache(maxsize=512)
def _airport_info(iata):
    """Name and coordinates for an airport code (coordinates may be None)."""
    unknown = {"airport": "Unknown Airport", "lat": None, "lon": None}
    try:
        airports = _get_airports_df()
    except Exception:
        LOGGER.exception("Unable to load airports list")
        return unknown

    code = str(iata).strip().upper()
    iata_col = airports["IATA"].astype(str).str.strip().str.upper()
    matches = airports.loc[iata_col == code]

    if matches.empty:
        return unknown

    row = matches.iloc[0]
    return {
        "airport": f"{row['Name']}, {row['City']}",
        "lat": round(float(row["Latitude"]), 3),
        "lon": round(float(row["Longitude"]), 3),
    }


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
        clean_data = spy.get_bufkit_data(
            req.model.lower(), req.site.strip().lower(), int(req.fcst_hr), *run,
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


def _render_png(clean_data, s):
    """Render a sounding or hodograph and return the PNG bytes."""
    storm_motion = s.storm_motion
    if isinstance(storm_motion, list):
        storm_motion = [int(v) for v in storm_motion]

    common = dict(
        dark_mode=s.dark_mode,
        storm_motion=storm_motion,
        modify_sfc=s.modify_sfc or False,
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

    with TemporaryDirectory(prefix="sounderpy_plot_") as tmpdir:
        output = Path(tmpdir) / "plot.png"

        with PLOT_LOCK:
            try:
                if s.hodo:
                    spy.build_hodograph(clean_data, filename=str(output), **common)
                else:
                    spy.build_sounding(
                        clean_data,
                        color_blind=s.color_blind,
                        special_parcels=None if s.ecape else "simple",
                        filename=str(output),
                        **common,
                    )
            finally:
                plt.close("all")

        return output.read_bytes()


def _export_file(clean_data, file_type):
    """Export SounderPy data to text. Returns (bytes, filename, content type)."""
    suffix, content_type = EXPORTS[file_type]

    with TemporaryDirectory(prefix="sounderpy_export_") as tmpdir:
        output = Path(tmpdir) / f"sounderpy_data{suffix}"
        spy.to_file(file_type, clean_data, filename=str(output))
        return output.read_bytes(), output.name, content_type


def _fetch_latest_runs():
    runs = []
    station = "KMOP"

    for model in BUFKIT_MODELS:
        model3 = "gfs3" if model == "gfs" else model
        data_url = (
            f"http://www.meteo.psu.edu/bufkit/data/"
            f"{model.upper()}/{model3}_{station.lower()}.buf"
        )

        try:
            response = requests.get(data_url, timeout=10)
            response.raise_for_status()
            lines = response.text.splitlines()

            if len(lines) < 5 or "TIME" not in lines[4]:
                raise ValueError("BUFKIT header does not contain expected TIME field")

            run_line = lines[4]
            start = run_line.index("TIME") + 7
            run_time = run_line[start:start + 11]
            latest = f"{run_time[2:4]}/{run_time[4:6]} {run_time[7:9]}Z"

        except Exception:
            LOGGER.exception("Unable to determine latest %s BUFKIT run", model)
            latest = None

        runs.append({"model": model, "latest_run": latest})

    return runs


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
)


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
    results = []

    for hour_str in hours:
        try:
            profiles = spy.acars_data(*_ymd(day), hour_str).list_profiles()
        except Exception:
            LOGGER.debug("No ACARS result for %s %sZ", day, hour_str, exc_info=True)
            continue

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
        clean_data, label = _load_data(req)
    except HTTPException:
        raise
    except Exception as exc:
        LOGGER.exception("Data retrieval failed for %s", req.model_dump(exclude={"settings"}))
        raise HTTPException(
            502,
            f"No data could be retrieved for this request ({type(exc).__name__}). "
            "Check the site, date, and hour, then try again.",
        )

    try:
        if req.output != "png":
            content, filename, content_type = _export_file(clean_data, req.output)
            return Response(
                content,
                media_type=content_type,
                headers={"Content-Disposition": f'attachment; filename="{filename}"'},
            )

        png = _render_png(clean_data, req.settings)
    except Exception as exc:
        LOGGER.exception("Rendering failed for %s", req.model_dump())
        raise HTTPException(500, f"The plot could not be generated ({type(exc).__name__}).")

    LOGGER.info("%s %s served in %.1fs", req.source, req.output, time.time() - started)
    return {
        "label": label,
        "info": _sounding_info(clean_data, req.source),
        "image": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
    }
