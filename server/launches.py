"""Which RAOB sites launched at a given time, from Iowa State's IEM archive.

The API reads this store. sounderpy_launches.timer runs this file to refresh recent launch times:

    python launches.py
"""

import datetime as dt
import logging
import os
import sys
from pathlib import Path

import diskcache
import requests

LOGGER = logging.getLogger("sounderpy-api")

IEM_RAOB_URL = "https://mesonet.agron.iastate.edu/json/raob.py"
CYCLE_HOURS = 6  # 00, 06, 12 and 18Z
RECENT_CYCLES = 9  # enough to cover the last two days
RECENT_WINDOW = dt.timedelta(days=2)
CHECK_DELAY = dt.timedelta(hours=1)  # the timer checks a launch time an hour after it
RETRY_SECONDS = 3600  # lists that may still fill in, when the timer isn't the one keeping them current
FINAL_AFTER = dt.timedelta(days=2)

# IEM IDs that SounderPy's station list (RAOB-STATIONS-MASTER.csv) files under another ICAO code. The map
# finds a station by any of its IDs, but a launch list should name the station the way the map does.
STATION_ALIASES = {
    "CWMJ": "CWMW", "CWPL": "CYPL", "CWQI": "CYQI", "CYEU": "CWEU", "CYLT": "CWLT", "CYPH": "CWPH", "CZXS": "CYXS",
    "KALY": "KALB", "KNKX": "KMYF", "KLKN": "KEKO", "KMFL": "KMIA", "KOTX": "KGEG", "KSIL": "KLIX", "MMGM": "MGYM",
    "PANN": "PANT", "PBET": "PABE", "PBRW": "PABR", "PCDB": "PACD", "PFAI": "PAFA", "PITO": "PHTO",
    "PMCG": "PAMC", "POME": "PAOM", "POTZ": "PAOT", "PYAK": "PAYA",
    # Stored lists from before the new station list used these IDs, which it now lists under their own codes.
    "CZAG": "CYAH", "KNYL": "K1Y7", "74626": "KPSR", "MCUN": "MMUN", "PLIH": "PHLI",
}


def _map_ids(stations):
    """A launch list with each site named as the station map names it."""
    return sorted({STATION_ALIASES.get(station, station) for station in stations})


# Kept apart from the profile cache, which removes old entries: this is a permanent record.
LAUNCH_STORE = diskcache.Cache(
    os.environ.get("LAUNCH_STORE_DIR", str(Path(__file__).parent / "launches")),
    eviction_policy="none",
)


def _store_key(when):
    return when.strftime("%Y-%m-%dT%HZ")


def _fetch_stations(when):
    """Sorted site IDs with a sounding at this time, as IEM names them."""
    response = requests.get(IEM_RAOB_URL, params={"ts": when.strftime("%Y-%m-%dT%H:00:00Z")}, timeout=60)
    response.raise_for_status()
    stations = (profile["station"] for profile in response.json()["profiles"])
    return sorted(set(stations))


def get_launches(day, hour):
    """Sites that launched at this date and hour. Raises if IEM can't be reached and nothing is stored."""
    when = dt.datetime(day.year, day.month, day.day, hour, tzinfo=dt.timezone.utc)
    now = dt.datetime.now(dt.timezone.utc)
    if when > now:
        return []

    key = _store_key(when)
    stations = LAUNCH_STORE.get(key)
    if stations is None:
        stations = _fetch_stations(when)
        final = stations and now - when >= FINAL_AFTER
        LAUNCH_STORE.set(key, stations, expire=None if final else RETRY_SECONDS)
    return _map_ids(stations)


def _recent_cycles(now):
    """Launch times from the last two days that have reached their check, newest first."""
    checked = now - CHECK_DELAY
    newest = checked.replace(hour=checked.hour - checked.hour % CYCLE_HOURS, minute=0, second=0, microsecond=0)
    cycles = (newest - dt.timedelta(hours=CYCLE_HOURS * i) for i in range(RECENT_CYCLES))
    return [when for when in cycles if now - when <= RECENT_WINDOW]


def recent_launches():
    """[{time, stations}] for the last two days, newest first. Raises if none can be loaded."""
    results, error = [], None
    for when in _recent_cycles(dt.datetime.now(dt.timezone.utc)):
        try:
            results.append({"time": when.strftime("%Y-%m-%dT%H:00:00Z"), "stations": get_launches(when.date(), when.hour)})
        except (requests.RequestException, KeyError, ValueError) as exc:
            LOGGER.warning("Launch list unavailable for %s: %s", _store_key(when), exc)
            error = exc
    if error and not results:
        raise error
    return results


def refresh(now=None):
    """Update the recent launch times. Returns how many couldn't be fetched."""
    now = now or dt.datetime.now(dt.timezone.utc)
    failures = 0

    for when in _recent_cycles(now):
        key = _store_key(when)
        try:
            # A launch doesn't un-happen, so a partial response can't shrink a list.
            stations = sorted(set(_fetch_stations(when)) | set(LAUNCH_STORE.get(key) or []))
        except (requests.RequestException, KeyError, ValueError):
            LOGGER.exception("Launch check failed for %s", key)
            failures += 1
            continue
        LAUNCH_STORE.set(key, stations, expire=None if stations else RETRY_SECONDS)
        LOGGER.info("launches %s: %d sites", key, len(stations))

    return failures


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
    sys.exit(1 if refresh() else 0)
