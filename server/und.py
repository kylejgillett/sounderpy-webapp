"""UND sounding ops: a password-protected uploader for UND's own radiosonde launches.

The page (src/pages/und.astro) sends a GRAW, iMet, or Windsond file. This module reads it with SounderPy, draws the
plot, and archives the raw file and the PNG under a random launch ID. Publishing sends that saved PNG
to the UND map wall; that step isn't connected yet (see _send_to_wall).

Everything here sits behind one shared login. It's off unless these are set in the service's environment:

    UND_PASSWORD_HASH   from `python und.py hash-password` (never the password itself)
    UND_SECRET          signs session cookies: python3 -c "import secrets; print(secrets.token_urlsafe(32))"

Optional:

    UND_ARCHIVE_DIR     where launches are kept (default: server/und-archive)
    UND_SESSION_HOURS   how long a login lasts (default 12)
    UND_WALL_DRY_RUN=1  mark launches published without sending anything, for testing
    UND_COOKIE_INSECURE=1  drop the cookie's Secure flag, for plain-HTTP testing off localhost

Changing UND_PASSWORD_HASH or UND_SECRET signs everyone out.
"""

import asyncio
import base64
import datetime as dt
import gzip
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import shutil
import sys
import threading
import time
import warnings
from collections import defaultdict, deque
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Annotated, Literal, Optional

import numpy as np
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, FiniteFloat, ValidationError, field_validator

LOGGER = logging.getLogger("sounderpy-api.und")

# The radiosonde readers note the site details a file doesn't hold (we fill those in), on every read.
# Their warnings about the data itself (gaps, no surface wind) still reach the log.
try:
    from sounderpy.utils import SounderPyNotice
    warnings.filterwarnings("ignore", category=SounderPyNotice)
except ImportError:  # SounderPy before the readers' Nov 2026 update
    pass

# -----------------------------------------------------------------------------
# CONFIGURATION
# -----------------------------------------------------------------------------

PASSWORD_HASH = os.environ.get("UND_PASSWORD_HASH", "")
SECRET = os.environ.get("UND_SECRET", "")
ENABLED = bool(PASSWORD_HASH and SECRET)
ARCHIVE_DIR = Path(os.environ.get("UND_ARCHIVE_DIR", str(Path(__file__).parent / "und-archive")))
SESSION_SECONDS = int(float(os.environ.get("UND_SESSION_HOURS", "12")) * 3600)
WALL_DRY_RUN = os.environ.get("UND_WALL_DRY_RUN") == "1"
COOKIE_SECURE = os.environ.get("UND_COOKIE_INSECURE") != "1"

COOKIE = "und_session"
COOKIE_PATH = "/api/und"

# Full 1-second launch files run 1-3 MB (a whole iMet flight is about 1.7 MB). JSON escaping adds a little.
MAX_FILE_CHARS = 5 * 1024 ** 2
MAX_BODY_BYTES = 6 * 1024 ** 2
PLOT_LEVELS = 500  # SounderPy's max_levels: about 30 m apart on a full flight, for ~4 s more than 150 and no more memory
MIN_LEVELS = 10
UNPUBLISHED_KEEP_SECONDS = 2 * 3600  # plots nobody published; published launches are kept indefinitely
DEFAULT_TITLE = "University of North Dakota Observed Vertical Profile"

# Logins: per address and in total, counting every attempt. Wrong passwords also wait a moment.
LOGIN_LIMITS_PER_IP = ((900, 5), (86400, 30))  # (seconds, attempts)
LOGIN_LIMIT_TOTAL = (3600, 60)
LOGIN_FAIL_DELAY = 1.0

# scrypt: 16 MB and roughly 50 ms per check.
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1

LAUNCH_ID = re.compile(r"[A-Za-z0-9_-]{16}")
READERS = {"graw": ("from_graw", ".txt"), "imet": ("from_imet", ".csv"), "windsond": ("from_windsond", ".csv")}
RECORD_LOCK = threading.Lock()  # record.json reads and writes
PENDING = threading.BoundedSemaphore(1)  # one UND plot at a time, so ops can't crowd out the public site

# Same rule as public upload labels: letters, numbers, basic punctuation, nothing Matplotlib reads as math.
PLAIN_TEXT = re.compile(r"[\w .,:;'()/#+|\-]*")


# -----------------------------------------------------------------------------
# PASSWORD AND SESSIONS
# -----------------------------------------------------------------------------

def hash_password(password):
    """'scrypt$n$r$p$salt$hash', with base64 salt and hash."""
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    b64 = lambda b: base64.b64encode(b).decode("ascii")
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${b64(salt)}${b64(digest)}"


def _password_ok(password):
    try:
        scheme, n, r, p, salt, expected = PASSWORD_HASH.split("$")
        if scheme != "scrypt":
            return False
        digest = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p),
                                dklen=len(base64.b64decode(expected)))
    except (ValueError, TypeError):
        LOGGER.error("UND_PASSWORD_HASH isn't a valid hash; make a new one with `python und.py hash-password`")
        return False
    return hmac.compare_digest(digest, base64.b64decode(expected))


def _signing_key():
    # The password hash is part of the key, so a new password ends every session.
    return hashlib.sha256(f"{SECRET}\n{PASSWORD_HASH}".encode()).digest()


def _make_token(expires):
    payload = base64.urlsafe_b64encode(json.dumps({"exp": int(expires)}).encode()).decode().rstrip("=")
    signature = hmac.new(_signing_key(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"


def _token_expiry(token):
    """When a valid token expires (epoch seconds), or None if it's forged, malformed, or expired."""
    try:
        payload, signature = token.split(".")
        expected = hmac.new(_signing_key(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        expires = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["exp"]
    except (ValueError, KeyError, TypeError):
        return None
    return expires if expires > time.time() else None


def _require_enabled():
    if not ENABLED:
        raise HTTPException(503, "The UND uploader isn't set up on this server.")


def _require_login(request):
    _require_enabled()
    if not _token_expiry(request.cookies.get(COOKIE, "")):
        raise HTTPException(401, "Please sign in again.")


LOGIN_HITS_LOCK = threading.Lock()
LOGIN_HITS = defaultdict(deque)


def _check_login_rate(ip):
    now = time.time()
    longest = max(seconds for seconds, _ in LOGIN_LIMITS_PER_IP)
    with LOGIN_HITS_LOCK:
        for key, limits in ((ip, LOGIN_LIMITS_PER_IP), ("*", (LOGIN_LIMIT_TOTAL,))):
            hits = LOGIN_HITS[key]
            while hits and now - hits[0] > max(longest, LOGIN_LIMIT_TOTAL[0]):
                hits.popleft()
            for seconds, allowed in limits:
                if sum(1 for h in hits if now - h < seconds) >= allowed:
                    minutes = max(1, round(seconds / 60))
                    raise HTTPException(429, f"Too many sign-in attempts. Try again in up to {minutes} minutes.",
                                        headers={"Retry-After": str(seconds)})
        LOGIN_HITS[ip].append(now)
        LOGIN_HITS["*"].append(now)


# -----------------------------------------------------------------------------
# REQUESTS
# -----------------------------------------------------------------------------

class LoginRequest(BaseModel):
    password: str = Field(max_length=200)


class CheckRequest(BaseModel, extra="forbid"):
    """A file to read without plotting: just enough for the reader."""
    format: Literal["graw", "imet", "windsond"]
    filename: str = Field(default="", max_length=120)
    text: str = Field(min_length=1, max_length=MAX_FILE_CHARS)
    elevation: Optional[Annotated[FiniteFloat, Field(ge=-500, le=9000)]] = None

    @field_validator("filename")
    @classmethod
    def safe_filename(cls, value):
        """Used as the temporary file's name (for a GRAW date), so only letters, digits, . _ and -."""
        return re.sub(r"[^\w.\-]+", "_", value.strip()).lstrip(".")[:120]


def _plain(value):
    value = value.strip()
    if not PLAIN_TEXT.fullmatch(value):
        raise ValueError("unsupported characters")
    return value


def plot_request_model(settings_model):
    """The plot request, built around api.py's Settings so the figure options match the public site."""

    class UndPlotRequest(BaseModel, extra="forbid"):
        format: Literal["graw", "imet", "windsond"]
        filename: str = Field(default="", max_length=120)
        text: str = Field(min_length=1, max_length=MAX_FILE_CHARS)  # the file itself; both formats are text
        date: dt.date
        time: dt.time
        lat: Annotated[FiniteFloat, Field(ge=-90, le=90)]
        lon: Annotated[FiniteFloat, Field(ge=-180, le=180)]
        # m above sea level. Windsond files hold heights above ground only, so they need it; others ignore it.
        elevation: Optional[Annotated[FiniteFloat, Field(ge=-500, le=9000)]] = None
        title: str = Field(default=DEFAULT_TITLE, max_length=60)
        location: str = Field(default="", max_length=40)
        settings: settings_model = Field(default_factory=settings_model)

        @field_validator("title", "location")
        @classmethod
        def plain_text(cls, value):
            return _plain(value)

        @field_validator("filename")
        @classmethod
        def safe_filename(cls, value):
            """Kept for the archive record only, never used as a path."""
            return re.sub(r"[^\w.\-]+", "_", value.strip())[:120]

    return UndPlotRequest


def _problem(exc):
    error = exc.errors()[0]
    field = str(error["loc"][0]) if error["loc"] else ""
    return {
        "format": "Choose a GRAW, iMet, or Windsond file.",
        "elevation": "The launch site elevation must be in meters, from -500 to 9000.",
        "text": "The file is empty or larger than 5 MB.",
        "date": "Enter a valid date.",
        "time": "Enter a valid UTC time.",
        "lat": "Latitude must be between -90 and 90.",
        "lon": "Longitude must be between -180 and 180.",
        "title": "Keep the main title to 60 characters, using letters, numbers and basic punctuation.",
        "location": "Keep the location name to 40 characters, using letters, numbers and basic punctuation.",
        "settings": "One of the figure settings isn't valid.",
    }.get(field, "The request couldn't be read. Choose the file again.")


async def _read_body(request):
    """Read at most MAX_BODY_BYTES, whatever Content-Length claims."""
    too_large = HTTPException(413, "That file is too large. The limit is 5 MB.")
    try:
        if int(request.headers.get("content-length", 0)) > MAX_BODY_BYTES:
            raise too_large
    except ValueError:
        raise HTTPException(400, "Bad request.")
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_BODY_BYTES:
            raise too_large
    return bytes(body)


# -----------------------------------------------------------------------------
# READING, PLOTTING, ARCHIVING
# -----------------------------------------------------------------------------

def _read_file(spy, req, date=None, name=None):
    """The file through SounderPy's reader. GRAW files hold the time of day but not the date, so it
    gets `date`, or with date=None reads it from the temporary file's `name` ('20260125_2100.txt'),
    which is then the uploaded file's own name."""
    reader, suffix = READERS[req.format]
    if req.format == "windsond" and req.elevation is None:
        raise HTTPException(422, "Windsond files don't include the launch site's elevation. Enter it in meters.")
    with TemporaryDirectory(prefix="sounderpy_und_") as tmpdir:
        path = Path(tmpdir) / (name or f"upload{suffix}")
        path.write_text(req.text, encoding="utf-8")
        kwargs = {"graw": {"date": date}, "windsond": {"elevation": req.elevation}}.get(req.format, {})
        try:
            return getattr(spy, reader)(str(path), **kwargs)
        except ValueError as exc:  # the readers' own messages are written for people
            raise HTTPException(422, str(exc))
        except (Exception, SystemExit) as exc:
            LOGGER.error("UND %s file failed to read: %s", req.format, type(exc).__name__)
            name = {"graw": "GRAW", "imet": "iMet", "windsond": "Windsond"}[req.format]
            raise HTTPException(422, f"This doesn't look like a {name} file SounderPy can read. Check the file type.")


GRAW_DATED_NAME = re.compile(r"\d{8}[\w.\-]*")


def check_file(spy, req):
    """Read a file without drawing it, so the page can fill in the launch time and show what's in it.

    A GRAW date comes from the file's name when it starts with YYYYMMDD (SounderPy then also moves a
    launch near midnight to the right day), and otherwise is today's UTC date, flagged as a guess.
    """
    date, name, date_guessed = None, None, False
    if req.format == "graw":
        if GRAW_DATED_NAME.fullmatch(req.filename or ""):
            name = req.filename
        else:
            date, date_guessed = dt.datetime.now(dt.timezone.utc).date(), True
    data = _read_file(spy, req, date=date, name=name)
    launch = data["site_info"].get("launch-time")
    if date_guessed and launch and dt.datetime.fromisoformat(launch.replace("Z", "+00:00")) > dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5):
        # Today's date would put the launch in the future: it was launched before midnight UTC, yesterday.
        data = _read_file(spy, req, date=date - dt.timedelta(days=1), name=name)
    return {"format": req.format, **_summary(data), "date_guessed": date_guessed}


def _summary(data):
    """What was read, for the page to show before anyone publishes."""
    p, z = data["p"].m, data["z"].m
    info = data["site_info"]
    missing_wind = info.get("missing-sfc-wind")
    if missing_wind is None:  # SounderPy before the readers' Nov 2026 update
        missing_wind = not np.isfinite(data["u"].m[0])
    return {
        "levels": int(len(p)),
        "surface": {"pressure": round(float(p[0]), 1), "height": int(round(float(z[0])))},
        "top": {"pressure": round(float(p[-1]), 1), "height": int(round(float(z[-1])))},
        # From the file when it has one: ISO 8601 UTC, e.g. '2026-01-25T20:26:35Z'.
        "launch_time": info.get("launch-time"),
        "valid_time": info.get("valid-time"),
        "file_latlon": info.get("site-latlon"),
        "surface_wind_missing": bool(missing_wind),
        "gaps": info.get("data-gaps") or [],
    }


def _clean_data(data, req):
    """The reader's profile, labelled with the form's place, time, and titles."""
    place = " | ".join(filter(None, [req.location, f"{req.lat:.2f}, {req.lon:.2f}"]))
    info = data["site_info"]
    data = dict(data)
    data["site_info"] = {
        **info,
        "site-id": "UND",
        "site-name": req.location or "UND",
        "site-lctn": req.location,
        "site-latlon": [req.lat, req.lon],
        "model": "no-model",
        "fcst-hour": "no-fcst-hour",
        "run-time": ["none", "none", "none", "none"],
        "valid-time": [f"{req.date:%Y}", f"{req.date:%m}", f"{req.date:%d}", f"{req.time:%H%M}"],
    }
    data["titles"] = {
        "top_title": req.title or DEFAULT_TITLE,
        "left_title": f"VALID: {req.date:%m-%d-%Y} {req.time:%H%M}Z | {place}",
        "right_title": f"{info.get('source', req.format.upper())}    ",
    }
    return data


def _launch_dir(launch_id):
    if not LAUNCH_ID.fullmatch(launch_id or ""):
        raise HTTPException(404, "No launch with that ID.")
    folder = ARCHIVE_DIR / launch_id
    if not (folder / "record.json").is_file():
        raise HTTPException(404, "No launch with that ID.")
    return folder


def _read_record(folder):
    return json.loads((folder / "record.json").read_text())


def _write_record(folder, record):
    tmp = folder / "record.json.tmp"
    tmp.write_text(json.dumps(record, indent=1))
    tmp.replace(folder / "record.json")  # atomic, so a crash never leaves half a record


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _clean_up():
    """Delete plots that were never published once they're UNPUBLISHED_KEEP_SECONDS old."""
    if not ARCHIVE_DIR.is_dir():
        return
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=UNPUBLISHED_KEEP_SECONDS)
    with RECORD_LOCK:
        for folder in ARCHIVE_DIR.iterdir():
            try:
                record = _read_record(folder)
                if record["status"] == "plotted" and dt.datetime.fromisoformat(record["created"]) < cutoff:
                    shutil.rmtree(folder)
            except (OSError, ValueError, KeyError):
                continue


def _archive(req, png, summary, notes, levels):
    launch_id = secrets.token_urlsafe(12)  # 16 characters, matching LAUNCH_ID
    folder = ARCHIVE_DIR / launch_id
    folder.mkdir(parents=True)
    suffix = READERS[req.format][1]
    with gzip.open(folder / f"raw{suffix}.gz", "wt", encoding="utf-8") as f:
        f.write(req.text)
    (folder / "plot.png").write_bytes(png)
    record = {
        "id": launch_id,
        "status": "plotted",  # plotted -> sending -> published (or failed) -> sending -> retracted
        "created": _now(),
        "format": req.format,
        "filename": req.filename,
        "date": req.date.isoformat(),
        "time": req.time.strftime("%H:%M"),
        "lat": req.lat,
        "lon": req.lon,
        "elevation": req.elevation if req.format == "windsond" else None,
        "title": req.title,
        "location": req.location,
        "settings": req.settings.model_dump(mode="json"),
        "summary": summary,
        "levels": levels,
        "notes": notes,
        "history": [],
    }
    with RECORD_LOCK:
        _write_record(folder, record)
    return record


def plot_launch(spy, render_png, req):
    """Read, draw, and archive one launch file. Returns the record and the PNG."""
    if not PENDING.acquire(blocking=False):
        raise HTTPException(503, "Another UND plot is drawing. Try again in a moment.", headers={"Retry-After": "15"})
    started = time.time()
    try:
        data = _read_file(spy, req, date=req.date)
        if len(data["p"]) < MIN_LEVELS:
            raise HTTPException(422, f"The file has only {len(data['p'])} usable levels. Is the flight too short?")
        summary = _summary(data)
        settings = req.settings
        if settings.radar and not settings.map_zoom:  # radar is drawn on the map
            settings = settings.model_copy(update={"map_zoom": 1})
        try:
            png, notes = render_png(_clean_data(data, req), settings, max_levels=PLOT_LEVELS)
        except (Exception, SystemExit) as exc:
            LOGGER.error("UND %s plot of %d levels failed to draw: %s", req.format, summary["levels"], type(exc).__name__)
            raise HTTPException(500, "SounderPy read the file but couldn't draw it. Try turning off surface edits, or check the file.")
    finally:
        PENDING.release()

    levels = {"read": summary["levels"], "plotted": min(summary["levels"], PLOT_LEVELS)}
    record = _archive(req, png, summary, notes, levels)
    LOGGER.info("UND %s plot %s levels=%d drawn in %.1fs", req.format, record["id"], summary["levels"], time.time() - started)
    return record, png


# -----------------------------------------------------------------------------
# THE MAP WALL (not connected yet)
# -----------------------------------------------------------------------------

def _send_to_wall(png_path, launch_id):
    """Send the saved PNG to the UND map wall. Returns None, or raises RuntimeError with a short reason.

    To do: the wall's fixed curl command, with a timeout. Only this launch's own saved file goes;
    nothing from the request is added to the command.
    """
    if WALL_DRY_RUN:
        LOGGER.info("UND %s: dry run, nothing sent to the wall", launch_id)
        return
    raise RuntimeError("Sending to the map wall isn't set up yet.")


def _remove_from_wall(launch_id):
    """Ask the wall to take a launch down. To do: the wall's fixed curl command for removal."""
    if WALL_DRY_RUN:
        LOGGER.info("UND %s: dry run, nothing removed from the wall", launch_id)
        return
    raise RuntimeError("Removing from the map wall isn't set up yet.")


def _change_status(launch_id, action):
    """publish or retract a launch, recording the attempt either way."""
    folder = _launch_dir(launch_id)
    with RECORD_LOCK:
        record = _read_record(folder)
        if record["status"] == "sending":
            raise HTTPException(409, "This launch is being sent to the wall right now.")
        allowed = {"publish": {"plotted", "failed"}, "retract": {"published"}}[action]
        if record["status"] not in allowed:
            raise HTTPException(409, {
                "publish": f"This launch is already {record['status']}.",
                "retract": "Only a published launch can be removed from the wall.",
            }[action])
        # Claimed under the lock, so a double click can't send it twice.
        before = record["status"]
        record["status"] = "sending"
        _write_record(folder, record)

    try:
        if action == "publish":
            _send_to_wall(folder / "plot.png", launch_id)
        else:
            _remove_from_wall(launch_id)
        status, error = ("published" if action == "publish" else "retracted"), None
    except RuntimeError as exc:
        status, error = ("failed" if action == "publish" else before), str(exc)

    with RECORD_LOCK:
        record = _read_record(folder)
        record["status"] = status
        record["history"].append({"action": action, "at": _now(), "ok": error is None, **({"error": error} if error else {})})
        if action == "publish" and error is None:
            record["published"] = record["history"][-1]["at"]
        _write_record(folder, record)
    LOGGER.info("UND %s %s: %s", launch_id, action, "ok" if error is None else error)
    if error:
        raise HTTPException(502, error)
    return _public_record(record)


def _public_record(record):
    """What the page needs about a launch (no settings dump or file text)."""
    keys = ("id", "status", "created", "published", "format", "filename", "date", "time", "lat", "lon",
            "title", "location", "summary", "levels", "notes", "history")
    return {key: record.get(key) for key in keys}


def _list_launches(limit, include_unpublished):
    if not ARCHIVE_DIR.is_dir():
        return []
    records = []
    with RECORD_LOCK:
        for folder in ARCHIVE_DIR.iterdir():
            try:
                record = _read_record(folder)
            except (OSError, ValueError):
                continue
            if include_unpublished or record["status"] != "plotted":
                records.append(record)
    records.sort(key=lambda r: (r["date"], r["time"], r["created"]), reverse=True)
    return [_public_record(r) for r in records[:limit]]


# -----------------------------------------------------------------------------
# ROUTES
# -----------------------------------------------------------------------------

def create_router(spy, render_png, settings_model):
    """The /api/und routes. api.py passes in SounderPy, its renderer, and its Settings model."""
    router = APIRouter(prefix="/api/und")
    PlotRequest = plot_request_model(settings_model)

    @router.post("/login")
    async def login(body: LoginRequest, request: Request, response: Response):
        _require_enabled()
        _check_login_rate(request.client.host if request.client else "unknown")
        if not await run_in_threadpool(_password_ok, body.password):
            await asyncio.sleep(LOGIN_FAIL_DELAY)
            LOGGER.warning("UND sign-in failed")
            raise HTTPException(401, "That password isn't right.")
        expires = time.time() + SESSION_SECONDS
        response.set_cookie(COOKIE, _make_token(expires), max_age=SESSION_SECONDS, path=COOKIE_PATH,
                            httponly=True, secure=COOKIE_SECURE, samesite="strict")
        LOGGER.info("UND signed in")
        return {"expires": int(expires)}

    @router.post("/logout")
    def logout(response: Response):
        response.delete_cookie(COOKIE, path=COOKIE_PATH, httponly=True, secure=COOKIE_SECURE, samesite="strict")
        return {"ok": True}

    @router.get("/session")
    def session(request: Request):
        """Whether this browser is signed in, so the page can show the login box or the form."""
        _require_enabled()
        expires = _token_expiry(request.cookies.get(COOKIE, ""))
        return {"signed_in": bool(expires), "expires": expires}

    @router.post("/read")
    async def read(request: Request):
        """Read a file without drawing it: the launch time, levels, and any problems, in well under a second."""
        _require_login(request)
        body = await _read_body(request)
        try:
            req = CheckRequest.model_validate_json(body)
        except ValidationError as exc:
            raise HTTPException(422, _problem(exc))
        return await run_in_threadpool(check_file, spy, req)

    @router.post("/plot")
    async def plot(request: Request):
        """Step 1: read, draw, and archive. Returns the launch record and the plot as a data URL."""
        _require_login(request)
        body = await _read_body(request)
        try:
            req = PlotRequest.model_validate_json(body)
        except ValidationError as exc:
            raise HTTPException(422, _problem(exc))
        await run_in_threadpool(_clean_up)
        record, png = await run_in_threadpool(plot_launch, spy, render_png, req)
        return {**_public_record(record), "image": "data:image/png;base64," + base64.b64encode(png).decode("ascii")}

    @router.post("/launches/{launch_id}/publish")
    async def publish(launch_id: str, request: Request):
        """Step 2: send the saved plot to the map wall. Only the ID comes from the page."""
        _require_login(request)
        return await run_in_threadpool(_change_status, launch_id, "publish")

    @router.post("/launches/{launch_id}/retract")
    async def retract(launch_id: str, request: Request):
        _require_login(request)
        return await run_in_threadpool(_change_status, launch_id, "retract")

    @router.get("/launches")
    async def launches(request: Request, limit: int = 50, all: bool = False):
        """Past launches, newest first. all=true also lists recent plots that weren't published."""
        _require_login(request)
        return await run_in_threadpool(_list_launches, max(1, min(limit, 500)), all)

    @router.get("/launches/{launch_id}/plot.png")
    def launch_plot(launch_id: str, request: Request):
        _require_login(request)
        return FileResponse(_launch_dir(launch_id) / "plot.png", media_type="image/png")

    @router.get("/launches/{launch_id}/raw")
    def launch_raw(launch_id: str, request: Request):
        """The file as it was uploaded. To do: CSV and SHARPpy exports, and re-plotting, from this file."""
        _require_login(request)
        folder = _launch_dir(launch_id)
        record = _read_record(folder)
        suffix = READERS[record["format"]][1]
        with gzip.open(folder / f"raw{suffix}.gz", "rb") as f:
            content = f.read()
        name = record.get("filename") or f"und_{record['date']}_{record['time'].replace(':', '')}{suffix}"
        return Response(content, media_type="text/plain",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})

    return router


# -----------------------------------------------------------------------------
# COMMAND LINE: python und.py hash-password
# -----------------------------------------------------------------------------

if __name__ == "__main__":
    if sys.argv[1:] != ["hash-password"]:
        sys.exit("usage: python und.py hash-password")
    import getpass
    first = getpass.getpass("New UND password: ")
    if len(first) < 12:
        sys.exit("Use at least 12 characters (a long random one from a password manager is best).")
    if getpass.getpass("Again: ") != first:
        sys.exit("The two didn't match.")
    print(hash_password(first))
