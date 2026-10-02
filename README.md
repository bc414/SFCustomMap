# Muni Reach Map

A static map that shows where Muni (buses, light rail, streetcars, cable cars) can
take you **without transferring**, starting from the stops near where you're staying.

- Each route is drawn in its own color, starting at the stop where you'd board it.
- One shared shaded area shows everything within walking distance of a stop you can ride to.
- You can filter by day and time window. A route counts only if it leaves one of your starting stops during that window.

## Using the page

| Control | What it does |
|---|---|
| **Day / From–to** | Picks the schedule day and the time window. The legend shows roughly how many buses per hour each route runs in that window. |
| **At destination** | The walking radius in meters drawn around each reachable stop (straight line). |
| **Home to stop** | Every stop within this distance of home is a starting stop. |
| **Stop markers** | Click any stop near home to add or remove it as a starting stop. |
| **Home marker** | Drag it to move "home". |
| **Routes** | Turn routes on or off. Click a route name to zoom to it. |

Every setting is saved in the page URL, so you can bookmark a link or share it to get the same view.

To change the defaults (home location, radii, time window, colors), edit `site/config.js`.

## How it works

- `scripts/build_data.py` downloads Muni's GTFS feed (its published schedule data) and turns it into `site/data/muni.json`. That file holds the routes, stops, route shapes and the trip times for the next 7 days. It uses only the Python standard library.
- `site/` is a plain static page built with Leaflet (vendored in `site/vendor/`) on a CARTO/OpenStreetMap basemap. All the calculation happens in the browser.
- `.github/workflows/pages.yml` rebuilds the data and deploys the page to GitHub Pages on every push and once a day.

### Data source

By default the script downloads `https://gtfs.sfmta.com/transitdata/google_transit.zip`. If that stops working:

- set a repository **variable** `GTFS_URL` to a different feed URL, or
- add a repository **secret** `API_511_KEY` with a free key from <https://511.org/open-data/token>. The script then also tries 511's official Muni feed.

## Setup: GitHub Pages

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Settings → Environments → github-pages:** allow the branch you deploy from, if it isn't the default branch.
3. Push, or run the workflow manually from the **Actions** tab. The site URL appears in the run summary.

GitHub Pages for a *private* repository needs a paid GitHub plan. On a free plan, make the repository public.

## Running locally

```sh
python3 scripts/build_data.py            # downloads the feed, writes site/data/muni.json
python3 -m http.server -d site 8000      # open http://localhost:8000
```

To try it without network access, use the synthetic test feed:

```sh
python3 tests/make_fixture.py
python3 scripts/build_data.py --gtfs tests/fixture_gtfs
python3 -m unittest discover -s tests
```

## Limitations

- Walking areas are straight-line circles. They ignore the street grid and hills.
- No transfers, by design.
- Holidays use the published calendar for the dates covered. Real-time delays aren't shown.
