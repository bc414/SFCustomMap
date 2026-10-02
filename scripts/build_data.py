#!/usr/bin/env python3
"""Convert a Muni GTFS feed into the compact JSON the map page reads.

Usage:
    python3 scripts/build_data.py                      # download from GTFS_URL / defaults
    python3 scripts/build_data.py --gtfs feed.zip      # use a local zip or directory
    python3 scripts/build_data.py --start 2026-10-03   # first day of the 7-day window

Output: site/data/muni.json

Only the Python standard library is used so it runs anywhere (including
GitHub Actions) without installing anything.
"""

import argparse
import csv
import datetime as dt
import io
import json
import math
import os
import sys
import urllib.request
import zipfile
from collections import defaultdict

# Tried in order. GTFS_URL (env) wins; a 511.org key (env API_511_KEY) adds the
# official regional endpoint for Muni (operator SF). If all of these fail, the
# Mobility Database catalog is searched for Muni's feed (no key needed).
DEFAULT_URLS = [
    "https://gtfs.sfmta.com/transitdata/google_transit.zip",
]
MOBILITY_DB_CATALOGS = [
    "https://storage.googleapis.com/storage/v1/b/mdb-csv/o/sources.csv?alt=media",
    "https://bit.ly/catalogs-csv",
]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "site", "data", "muni.json")


# ---------------------------------------------------------------- loading

class Feed:
    """Reads GTFS tables from a zip file or a directory."""

    def __init__(self, path):
        self.path = path
        self.zip = zipfile.ZipFile(path) if zipfile.is_zipfile(path) else None
        if self.zip:
            # Some feeds nest the txt files inside a folder.
            self.names = {os.path.basename(n): n for n in self.zip.namelist() if n.endswith(".txt")}

    def has(self, table):
        if self.zip:
            return table + ".txt" in self.names
        return os.path.exists(os.path.join(self.path, table + ".txt"))

    def rows(self, table):
        if not self.has(table):
            return
        if self.zip:
            raw = self.zip.open(self.names[table + ".txt"])
            f = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        else:
            f = open(os.path.join(self.path, table + ".txt"), encoding="utf-8-sig", newline="")
        with f:
            for row in csv.DictReader(f):
                yield {k.strip(): (v or "").strip() for k, v in row.items() if k}


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "SFCustomMap/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def catalog_urls():
    """Muni feed URLs listed in the Mobility Database catalog (sources.csv)."""
    for catalog in MOBILITY_DB_CATALOGS:
        try:
            print(f"Searching the Mobility Database catalog {catalog} ...", file=sys.stderr)
            text = fetch(catalog).decode("utf-8-sig")
        except Exception as e:  # noqa: BLE001 - try the next catalog
            print(f"  failed: {e}", file=sys.stderr)
            continue
        found = []
        for row in csv.DictReader(io.StringIO(text)):
            provider = (row.get("provider") or "").lower()
            if row.get("data_type") != "gtfs" or not ("san francisco municipal" in provider or "sfmta" in provider):
                continue
            if (row.get("urls.authentication_type") or "0") not in ("", "0"):
                continue
            rank = 1 if (row.get("status") or "").lower() in ("deprecated", "inactive") else 0
            for key in ("urls.latest", "urls.direct_download"):
                if row.get(key):
                    found.append((rank, row[key]))
        urls = [u for _, u in sorted(found, key=lambda x: x[0])]
        print(f"  found {len(urls)} candidate URL(s)", file=sys.stderr)
        if urls:
            return urls
    return []


def download(urls, dest):
    last_err, tried, from_catalog = None, set(), False
    queue = list(urls)
    while True:
        if not queue and not from_catalog:
            from_catalog = True
            queue = catalog_urls()
        if not queue:
            break
        url = queue.pop(0)
        if url in tried:
            continue
        tried.add(url)
        try:
            print(f"Downloading {url.split('api_key=')[0]} ...", file=sys.stderr)
            body = fetch(url)
            if zipfile.is_zipfile(io.BytesIO(body)):
                with open(dest, "wb") as out:
                    out.write(body)
                return dest
            last_err = "response was not a zip file"
        except Exception as e:  # noqa: BLE001 - try the next source
            last_err = e
        print(f"  failed: {last_err}", file=sys.stderr)
    raise SystemExit(f"Could not download a GTFS feed (last error: {last_err})")


# ---------------------------------------------------------------- helpers

def parse_time(s):
    """GTFS HH:MM:SS (hours may exceed 24) -> minutes after midnight of the service day."""
    if not s:
        return None
    h, m, sec = s.split(":")
    return int(h) * 60 + int(m) + int(sec) / 60


def haversine(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def encode_polyline(points, precision=5):
    """Google encoded polyline algorithm (decoded in app.js)."""
    factor = 10 ** precision
    out, prev_lat, prev_lon = [], 0, 0
    for lat, lon in points:
        ilat, ilon = round(lat * factor), round(lon * factor)
        for v in (ilat - prev_lat, ilon - prev_lon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        prev_lat, prev_lon = ilat, ilon
    return "".join(out)


def snap_stops_to_shape(stop_coords, shape):
    """For each stop (in order) find the index of the nearest shape point,
    moving only forward so loops and out-and-back routes stay in order."""
    idx, start, n = [], 0, len(shape)
    for k, (slat, slon) in enumerate(stop_coords):
        best_j, best_d = start, float("inf")
        # Don't let an early stop grab a point near the end of the shape:
        # leave room for the remaining stops.
        limit = n - (len(stop_coords) - k - 1)
        for j in range(start, max(start + 1, limit)):
            d = haversine(slat, slon, shape[j][0], shape[j][1])
            if d < best_d:
                best_j, best_d = j, d
            elif best_d < 60 and d > best_d + 250:
                break  # passed the closest approach; stop before a later revisit
        idx.append(best_j)
        start = best_j
    return idx


# ---------------------------------------------------------------- building

def active_services(feed, dates):
    """{date: set(service_id)} using calendar.txt and calendar_dates.txt."""
    days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    active = {d: set() for d in dates}
    for row in feed.rows("calendar"):
        start = dt.datetime.strptime(row["start_date"], "%Y%m%d").date()
        end = dt.datetime.strptime(row["end_date"], "%Y%m%d").date()
        for d in dates:
            if start <= d <= end and row[days[d.weekday()]] == "1":
                active[d].add(row["service_id"])
    for row in feed.rows("calendar_dates"):
        d = dt.datetime.strptime(row["date"], "%Y%m%d").date()
        if d in active:
            if row["exception_type"] == "1":
                active[d].add(row["service_id"])
            elif row["exception_type"] == "2":
                active[d].discard(row["service_id"])
    return active


def build(feed, start_date, agency_filter=None):
    dates = [start_date + dt.timedelta(days=i) for i in range(7)]
    active = active_services(feed, dates)

    # Collapse the 7 dates into distinct "day types" (weekdays usually share one).
    day_type_of_set, day_types, days = {}, [], []
    for d in dates:
        key = frozenset(active[d])
        if key not in day_type_of_set:
            day_type_of_set[key] = len(day_types)
            day_types.append(key)
        days.append({"date": d.isoformat(), "dow": d.weekday(), "type": day_type_of_set[key]})
    if not any(day_types):
        raise SystemExit(f"No service is active between {dates[0]} and {dates[-1]}: is the feed current?")

    routes = {}
    for r in feed.rows("routes"):
        if agency_filter and r.get("agency_id") and r["agency_id"] not in agency_filter:
            continue
        routes[r["route_id"]] = r

    trips = {}
    for t in feed.rows("trips"):
        if t["route_id"] in routes:
            trips[t["trip_id"]] = t

    stops = {}
    for s in feed.rows("stops"):
        if s.get("location_type", "0") in ("", "0"):
            stops[s["stop_id"]] = s

    print("Reading stop_times ...", file=sys.stderr)
    trip_stops = defaultdict(list)
    for st in feed.rows("stop_times"):
        if st["trip_id"] not in trips or st["stop_id"] not in stops:
            continue
        t = parse_time(st.get("departure_time") or st.get("arrival_time"))
        trip_stops[st["trip_id"]].append((int(st["stop_sequence"]), st["stop_id"], t))

    # Group trips into patterns: same route, direction, shape and stop sequence.
    patterns = {}
    for trip_id, seq in trip_stops.items():
        seq.sort()
        if len(seq) < 2:
            continue
        trip = trips[trip_id]
        stop_ids = tuple(s for _, s, _ in seq)
        key = (trip["route_id"], trip.get("direction_id", ""), trip.get("shape_id", ""), stop_ids)
        p = patterns.get(key)
        if p is None:
            p = patterns[key] = {"trip": trip, "times": None, "starts": defaultdict(list)}
        times = [t for _, _, t in seq]
        if p["times"] is None and all(t is not None for t in times):
            p["times"] = times
        if times[0] is None:
            continue
        for ti, svc_set in enumerate(day_types):
            if trip["service_id"] in svc_set:
                p["starts"][ti].append(times[0])

    # Drop patterns that never run in the window.
    patterns = {k: p for k, p in patterns.items() if p["starts"]}

    print("Reading shapes ...", file=sys.stderr)
    used_shapes = {k[2] for k in patterns if k[2]}
    shape_pts = defaultdict(list)
    for row in feed.rows("shapes"):
        if row["shape_id"] in used_shapes:
            shape_pts[row["shape_id"]].append(
                (int(row["shape_pt_sequence"]), float(row["shape_pt_lat"]), float(row["shape_pt_lon"])))
    for sid in shape_pts:
        shape_pts[sid] = [(lat, lon) for _, lat, lon in sorted(shape_pts[sid])]

    # ---- emit compact arrays
    route_ids = sorted({k[0] for k in patterns}, key=route_sort_key(routes))
    route_index = {rid: i for i, rid in enumerate(route_ids)}
    out_routes = []
    for rid in route_ids:
        r = routes[rid]
        out_routes.append({
            "id": rid,
            "short": r.get("route_short_name") or rid,
            "long": r.get("route_long_name", ""),
            "type": int(r.get("route_type") or 3),
            "color": ("#" + r["route_color"]) if r.get("route_color") else None,
        })

    stop_ids_used = sorted({s for k in patterns for s in k[3]})
    stop_index = {sid: i for i, sid in enumerate(stop_ids_used)}
    out_stops = [[sid, stops[sid].get("stop_name", sid),
                  round(float(stops[sid]["stop_lat"]), 6), round(float(stops[sid]["stop_lon"]), 6)]
                 for sid in stop_ids_used]

    shape_index, out_shapes = {}, []
    out_patterns = []
    for key in sorted(patterns, key=lambda k: (route_index[k[0]], k[1], -len(k[3]))):
        p = patterns[key]
        rid, direction, shape_id, stop_ids = key
        times = p["times"]
        offsets = [round(t - times[0], 1) for t in times] if times else [0] * len(stop_ids)
        pat = {
            "r": route_index[rid],
            "d": int(direction) if direction.isdigit() else 0,
            "h": p["trip"].get("trip_headsign", ""),
            "s": [stop_index[s] for s in stop_ids],
            "o": offsets,
            "t": {str(ti): sorted(round(x, 1) for x in starts) for ti, starts in p["starts"].items()},
        }
        pts = shape_pts.get(shape_id)
        if pts and len(pts) >= 2:
            if shape_id not in shape_index:
                shape_index[shape_id] = len(out_shapes)
                out_shapes.append(encode_polyline(pts))
            pat["g"] = shape_index[shape_id]
            coords = [(float(stops[s]["stop_lat"]), float(stops[s]["stop_lon"])) for s in stop_ids]
            pat["gi"] = snap_stops_to_shape(coords, pts)
        out_patterns.append(pat)

    feed_info = next(feed.rows("feed_info"), {}) if feed.has("feed_info") else {}
    return {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "feedVersion": feed_info.get("feed_version", ""),
        "days": days,
        "routes": out_routes,
        "stops": out_stops,
        "shapes": out_shapes,
        "patterns": out_patterns,
    }


def route_sort_key(routes):
    def key(rid):
        name = routes[rid].get("route_short_name") or rid
        digits = "".join(c for c in name if c.isdigit())
        return (0, int(digits), name) if digits and name[0].isdigit() else (1, 0, name)
    return key


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gtfs", help="local GTFS zip or directory (skips download)")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--start", help="first date of the 7-day schedule window (YYYY-MM-DD); default today in SF")
    ap.add_argument("--agency", action="append", help="keep only these agency_id values (repeatable)")
    args = ap.parse_args()

    if args.start:
        start = dt.date.fromisoformat(args.start)
    else:
        # San Francisco is UTC-7/-8; close enough for picking "today".
        start = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=8)).date()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    path = args.gtfs
    if not path:
        urls = [os.environ["GTFS_URL"]] if os.environ.get("GTFS_URL") else []
        if os.environ.get("API_511_KEY"):
            urls.append("https://api.511.org/transit/datafeeds?operator_id=SF&api_key=" + os.environ["API_511_KEY"])
        urls += DEFAULT_URLS
        path = download(urls, os.path.join(os.path.dirname(args.out), "gtfs.zip"))

    data = build(Feed(path), start, set(args.agency) if args.agency else None)
    with open(args.out, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"Wrote {args.out}: {len(data['routes'])} routes, {len(data['stops'])} stops, "
          f"{len(data['patterns'])} patterns, {os.path.getsize(args.out) // 1024} KB", file=sys.stderr)


if __name__ == "__main__":
    main()
