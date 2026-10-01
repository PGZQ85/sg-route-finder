# SG Route Finder

A local, data-driven route planner for Singapore. It suggests the **5 fastest** and the **5 shortest** bus/MRT routes
between two places. The defaults are **Compass One → HarbourFront**.

## Run

```sh
npm run fetch-data   # once: downloads bus data + geocodes MRT stations into ./data (≈4 min, OneMap is throttled)
npm start            # http://localhost:5173
npm test             # headless check: Compass One → HarbourFront, both modes, with live arrivals
```

Requires Node 18+. There are no dependencies and no build step. `./data` is already included, so `npm start` is enough.

## Data sources

| Data | Source | Used for |
| --- | --- | --- |
| 5,200 bus stops, 600+ services, stop sequences, route shapes | busrouter.sg (`data.busrouter.sg/v1`) | bus network, map lines |
| Live bus arrivals | arrivelah (`arrivelah2.busrouter.sg`, LTA DataMall) | real waits at origin + every boarding stop; services not running now are dropped |
| 2-hour weather forecast | data.gov.sg real-time API | if showers are forecast, walking is weighted ×1.5 |
| PSI, taxi availability | data.gov.sg real-time API | conditions panel |
| MRT station coordinates, place search, map tiles | OneMap (SLA) | rail network, From/To search |

MRT line sequences (NSL, EWL, NEL, CCL, DTL, TEL) are defined in `scripts/fetch-data.mjs`.

## How routing works (`planner.js`)

- Graph: bus stops and MRT stations are nodes. Each bus direction and MRT direction is a ride pattern. Walking links join
  stops within 350 m, and stations to stops within 400 m. Your start and end connect to anything within 900 m.
- Dijkstra over (node | on-board pattern position) states.
  - **Fastest** minimises minutes: ride time + waits + walking, with a small penalty per boarding.
  - **Shortest** minimises travelled metres, with a 500 m-equivalent penalty per boarding.
- Five diverse alternatives: each accepted route spawns searches that ban one more of its lines.
  Routes riding between the same stops on parallel services (e.g. buses 61 / 166 / 145) are merged into one option.
- Live-aware: after planning, every bus boarding stop is checked against live arrivals and the plan is re-run.
  Up to three rounds; it refreshes every 60 s.
- Assumptions: buses run at 20 km/h off-peak and 16 km/h at peak. MRT runs at 42 km/h with a 0.5 min dwell.
  City Direct (6xx) and express (…e) buses only run at weekday peaks. Night services are excluded.
  All times are estimates.
