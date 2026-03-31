from contextlib import asynccontextmanager
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from .database import Base, engine, get_session
from .models import ListeningEvent, Performance
from .schemas import DashboardResponse, HealthResponse, ListeningEventRead, PerformanceSummary, StatsResponse
from .services.spotify import build_authorize_url, exchange_code_for_recent_tracks, import_recent_tracks, resolve_return_to


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(
    title="Classical Piano Tracker API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def build_performance_summary(row: tuple[Performance, int, int | None, object | None]) -> PerformanceSummary:
    performance, listen_count, total_ms, last_heard_at = row
    return PerformanceSummary(
        id=performance.id,
        composer=performance.composer,
        work_title=performance.work_title,
        pianist=performance.pianist,
        album_name=performance.album_name,
        spotify_track_name=performance.spotify_track_name,
        source_confidence=performance.source_confidence,
        listen_count=listen_count,
        total_minutes=round((total_ms or 0) / 60000, 1),
        last_heard_at=last_heard_at,
    )


def with_query_params(url: str, **params: str) -> str:
    split_result = urlsplit(url)
    query = dict(parse_qsl(split_result.query, keep_blank_values=True))
    query.update(params)
    return urlunsplit(
        (
            split_result.scheme,
            split_result.netloc,
            split_result.path,
            urlencode(query),
            split_result.fragment,
        )
    )


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.get("/api/dashboard", response_model=DashboardResponse)
def get_dashboard(session: Session = Depends(get_session)) -> DashboardResponse:
    total_listens = session.scalar(select(func.count(ListeningEvent.id))) or 0
    total_performances = session.scalar(select(func.count(Performance.id))) or 0
    composers_tracked = session.scalar(select(func.count(func.distinct(Performance.composer)))) or 0
    total_minutes_raw = session.scalar(select(func.sum(ListeningEvent.ms_played))) or 0

    top_performance_rows = session.execute(
        select(
            Performance,
            func.count(ListeningEvent.id).label("listen_count"),
            func.sum(ListeningEvent.ms_played).label("total_ms"),
            func.max(ListeningEvent.listened_at).label("last_heard_at"),
        )
        .join(ListeningEvent, ListeningEvent.performance_id == Performance.id)
        .group_by(Performance.id)
        .order_by(
            func.count(ListeningEvent.id).desc(),
            func.max(ListeningEvent.listened_at).desc(),
        )
        .limit(5)
    ).all()

    recent_listen_rows = session.scalars(
        select(ListeningEvent)
        .options(joinedload(ListeningEvent.performance))
        .order_by(ListeningEvent.listened_at.desc())
        .limit(8)
    ).all()

    recent_listens = [
        ListeningEventRead(
            id=listen.id,
            listened_at=listen.listened_at,
            ms_played=listen.ms_played,
            platform=listen.platform,
            track_name=listen.track_name,
            artist_name=listen.artist_name,
            album_name=listen.album_name,
            performance_id=listen.performance_id,
            composer=listen.performance.composer,
            work_title=listen.performance.work_title,
            pianist=listen.performance.pianist,
        )
        for listen in recent_listen_rows
    ]

    return DashboardResponse(
        stats=StatsResponse(
            total_listens=total_listens,
            total_performances=total_performances,
            composers_tracked=composers_tracked,
            total_minutes=round(total_minutes_raw / 60000, 1),
        ),
        top_performances=[build_performance_summary(row) for row in top_performance_rows],
        recent_listens=recent_listens,
    )


@app.get("/api/performances", response_model=list[PerformanceSummary])
def list_performances(session: Session = Depends(get_session)) -> list[PerformanceSummary]:
    rows = session.execute(
        select(
            Performance,
            func.count(ListeningEvent.id).label("listen_count"),
            func.sum(ListeningEvent.ms_played).label("total_ms"),
            func.max(ListeningEvent.listened_at).label("last_heard_at"),
        )
        .outerjoin(ListeningEvent, ListeningEvent.performance_id == Performance.id)
        .group_by(Performance.id)
        .order_by(Performance.composer.asc(), Performance.work_title.asc())
    ).all()
    return [build_performance_summary(row) for row in rows]


@app.get("/api/listens", response_model=list[ListeningEventRead])
def list_listens(session: Session = Depends(get_session)) -> list[ListeningEventRead]:
    listens = session.scalars(
        select(ListeningEvent)
        .options(joinedload(ListeningEvent.performance))
        .order_by(ListeningEvent.listened_at.desc())
    ).all()
    return [
        ListeningEventRead(
            id=listen.id,
            listened_at=listen.listened_at,
            ms_played=listen.ms_played,
            platform=listen.platform,
            track_name=listen.track_name,
            artist_name=listen.artist_name,
            album_name=listen.album_name,
            performance_id=listen.performance_id,
            composer=listen.performance.composer,
            work_title=listen.performance.work_title,
            pianist=listen.performance.pianist,
        )
        for listen in listens
    ]


@app.get("/api/spotify/login")
def spotify_login(return_to: str | None = None) -> RedirectResponse:
    authorize_url = build_authorize_url(return_to)
    return RedirectResponse(authorize_url, status_code=302)


@app.get("/api/spotify/callback")
def spotify_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    session: Session = Depends(get_session),
) -> RedirectResponse:
    try:
        return_to = resolve_return_to(state)
    except HTTPException:
        return_to = "http://127.0.0.1:5173"

    if error:
        redirect_url = with_query_params(
            return_to,
            spotify="error",
            message=error,
        )
        return RedirectResponse(redirect_url, status_code=302)

    if not code:
        redirect_url = with_query_params(
            return_to,
            spotify="error",
            message="Missing Spotify authorization code.",
        )
        return RedirectResponse(redirect_url, status_code=302)

    try:
        tracks = exchange_code_for_recent_tracks(code)
        summary = import_recent_tracks(session, tracks)
    except HTTPException as exc:
        session.rollback()
        message = str(exc.detail).strip() or "Spotify import failed."
        redirect_url = with_query_params(
            return_to,
            spotify="error",
            message=message,
        )
        return RedirectResponse(redirect_url, status_code=302)
    except Exception as exc:
        session.rollback()
        message = str(exc).strip() or "Spotify import failed."
        redirect_url = with_query_params(
            return_to,
            spotify="error",
            message=message,
        )
        return RedirectResponse(redirect_url, status_code=302)

    redirect_url = with_query_params(
        return_to,
        spotify="connected",
        imported=str(summary.imported_count),
        skipped=str(summary.skipped_count),
    )
    return RedirectResponse(redirect_url, status_code=302)
