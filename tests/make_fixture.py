#!/usr/bin/env python3
"""Generate a small synthetic Muni-like GTFS feed in tests/fixture_gtfs/.

The geometry is rough (straight lines near the real streets) - it exists only
to exercise scripts/build_data.py and the map page without network access.
"""

import csv
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixture_gtfs")

# route_id, short, long, type, color, waypoints, service pattern
ROUTES = [
    ("22", "22", "Fillmore", 3, "", [(37.7668, -122.3900), (37.7652, -122.4290), (37.7900, -122.4330)], "day"),
    ("55", "55", "Dogpatch", 3, "", [(37.7650, -122.4195), (37.7672, -122.3920), (37.7580, -122.3880)], "day"),
    ("T", "T", "Third Street", 0, "", [(37.7350, -122.3900), (37.7700, -122.3890), (37.7850, -122.3960), (37.7890, -122.4020)], "day"),
    ("10", "10", "Townsend", 3, "", [(37.7625, -122.3985), (37.7720, -122.4000), (37.7950, -122.4005)], "day"),
    ("8BX", "8BX", "Bayshore B Express", 3, "", [(37.7700, -122.4050), (37.7880, -122.4070)], "peak"),
    ("90", "90", "San Bruno Owl", 3, "", [(37.7600, -122.4060), (37.7660, -122.4060), (37.7990, -122.4080)], "owl"),
]


def densify(waypoints, step_m):
    pts = []
    for (a_lat, a_lon), (b_lat, b_lon) in zip(waypoints, waypoints[1:]):
        dist = math.hypot((b_lat - a_lat) * 111000, (b_lon - a_lon) * 88000)
        n = max(1, int(dist // step_m))
        for i in range(n):
            f = i / n
            pts.append((a_lat + (b_lat - a_lat) * f, a_lon + (b_lon - a_lon) * f))
    pts.append(waypoints[-1])
    return pts


def hm(minutes):
    return f"{int(minutes // 60):02d}:{int(minutes % 60):02d}:00"


def main():
    os.makedirs(OUT, exist_ok=True)
    w = lambda name: csv.writer(open(os.path.join(OUT, name + ".txt"), "w", newline=""))

    agency = w("agency")
    agency.writerow(["agency_id", "agency_name", "agency_url", "agency_timezone"])
    agency.writerow(["SFMTA", "San Francisco Municipal Transportation Agency", "https://www.sfmta.com", "America/Los_Angeles"])

    cal = w("calendar")
    cal.writerow(["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"])
    cal.writerow(["WKDY", 1, 1, 1, 1, 1, 0, 0, "20260101", "20271231"])
    cal.writerow(["SAT", 0, 0, 0, 0, 0, 1, 0, "20260101", "20271231"])
    cal.writerow(["SUN", 0, 0, 0, 0, 0, 0, 1, "20260101", "20271231"])

    routes, trips, stop_times, shapes, stops = w("routes"), w("trips"), w("stop_times"), w("shapes"), w("stops")
    routes.writerow(["route_id", "agency_id", "route_short_name", "route_long_name", "route_type", "route_color"])
    trips.writerow(["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "shape_id"])
    stop_times.writerow(["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"])
    shapes.writerow(["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"])
    stops.writerow(["stop_id", "stop_name", "stop_lat", "stop_lon", "location_type"])

    stop_n = 1000
    for rid, short, long_name, rtype, color, wps, pattern in ROUTES:
        routes.writerow([rid, "SFMTA", short, long_name, rtype, color])
        for direction in (0, 1):
            path = wps if direction == 0 else list(reversed(wps))
            shape_id = f"{rid}_{direction}"
            shape = densify(path, 40)
            for i, (lat, lon) in enumerate(shape):
                shapes.writerow([shape_id, f"{lat:.6f}", f"{lon:.6f}", i + 1])
            # Stops sit ~15 m to the side of the line (as real stops do).
            side = 0.00012 if direction == 0 else -0.00012
            stop_pts = densify(path, 300)
            ids = []
            for lat, lon in stop_pts:
                stop_n += 1
                ids.append(str(stop_n))
                stops.writerow([stop_n, f"{long_name} stop {stop_n}", f"{lat + side:.6f}", f"{lon + side:.6f}", 0])
            headsign = long_name + (" Outbound" if direction == 0 else " Inbound")
            schedule = {
                "day": [("WKDY", 5 * 60, 24 * 60, 10), ("SAT", 6 * 60, 24 * 60, 15), ("SUN", 7 * 60, 23 * 60, 20)],
                "peak": [("WKDY", 7 * 60, 9 * 60, 8), ("WKDY", 16 * 60, 18 * 60 + 30, 8)],
                "owl": [(svc, 24 * 60 + 60, 24 * 60 + 300, 30) for svc in ("WKDY", "SAT", "SUN")],
            }[pattern]
            for svc, start, end, headway in schedule:
                t0 = start
                while t0 < end:
                    trip_id = f"{rid}_{direction}_{svc}_{int(t0)}"
                    trips.writerow([rid, svc, trip_id, headsign, direction, shape_id])
                    for seq, sid in enumerate(ids):
                        t = t0 + seq * 1.5
                        stop_times.writerow([trip_id, hm(t), hm(t), sid, seq + 1])
                    t0 += headway
    print("fixture written to", OUT)


if __name__ == "__main__":
    main()
