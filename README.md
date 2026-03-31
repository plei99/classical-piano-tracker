# Classical Piano Tracker

Initial full-stack scaffold for a personal app that tracks classical piano performances from Spotify listening history.

## Structure

```text
backend/   FastAPI + SQLite API with seeded demo data
frontend/  React + Vite + Tailwind dashboard
```

## Backend

The backend models two core concepts:

- `performances`: a canonical recording of a work by a specific pianist
- `listening_events`: raw Spotify-derived listens linked back to a performance

There is also an initial Spotify history parser at `backend/app/services/spotify_history.py` for the JSON shape used by Spotify Extended Streaming History exports.

The initial API includes:

- `GET /health`
- `GET /api/dashboard`
- `GET /api/performances`
- `GET /api/listens`
- `GET /api/spotify/login`
- `GET /api/spotify/callback`
- `POST /api/dev/seed`

### Run the backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e .
uvicorn app.main:app --reload
```

To enable Spotify OAuth locally, copy `backend/.env.example` to `backend/.env` and set the Spotify app credentials. The backend reads `backend/.env` automatically, so a normal Uvicorn start is enough:

```bash
uvicorn app.main:app --reload
```

The SQLite database is stored at `backend/tracker.db`. On first startup, the app creates tables and seeds a small set of sample performances and listening events.

## Frontend

The frontend is a Vite React app styled with Tailwind CSS. It fetches dashboard data from the FastAPI backend and renders:

- headline stats
- top replayed performances
- recent listening activity

### Run the frontend

```bash
cd frontend
npm install
npm run dev
```

By default, the Vite dev server proxies `/api` requests to `http://127.0.0.1:8000`, so the dashboard fetches and Spotify connect flow work without extra frontend env configuration. If needed, override the backend origin with:

```bash
VITE_API_BASE_URL=http://127.0.0.1:8000
```

## Next steps

- import and parse Spotify Extended Streaming History exports
- add heuristic or manual matching from raw Spotify tracks to canonical performances
- support filtering by composer, pianist, era, and work
- add notes, favorites, and listening goals
