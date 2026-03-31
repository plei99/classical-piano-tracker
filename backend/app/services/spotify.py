import base64
import hashlib
import hmac
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from spotipy import Spotify
from spotipy.cache_handler import MemoryCacheHandler
from spotipy.oauth2 import SpotifyOAuth

from ..models import ListeningEvent, Performance

SPOTIFY_SCOPE = "user-read-recently-played"
DEFAULT_FRONTEND_URL = "http://127.0.0.1:5173"
ENV_FILE_PATH = Path(__file__).resolve().parents[2] / ".env"


@dataclass(slots=True)
class SpotifySettings:
    client_id: str
    client_secret: str
    redirect_uri: str


@dataclass(slots=True)
class ImportedListeningSummary:
    imported_count: int
    skipped_count: int


@dataclass(slots=True)
class SpotifyRecentTrack:
    listened_at: datetime
    ms_played: int
    track_name: str
    artist_name: str
    album_name: str
    spotify_uri: str | None


def get_spotify_settings() -> SpotifySettings:
    env_values = read_local_env_file()
    client_id = os.getenv("SPOTIFY_CLIENT_ID") or env_values.get("SPOTIFY_CLIENT_ID")
    client_secret = os.getenv("SPOTIFY_CLIENT_SECRET") or env_values.get("SPOTIFY_CLIENT_SECRET")
    redirect_uri = os.getenv("SPOTIFY_REDIRECT_URI") or env_values.get("SPOTIFY_REDIRECT_URI")
    if client_id and client_secret and redirect_uri:
        return SpotifySettings(
            client_id=client_id,
            client_secret=client_secret,
            redirect_uri=redirect_uri,
        )

    raise HTTPException(
        status_code=500,
        detail=(
            "Spotify OAuth is not configured. Set SPOTIFY_CLIENT_ID, "
            "SPOTIFY_CLIENT_SECRET, and SPOTIFY_REDIRECT_URI, or add them to backend/.env."
        ),
    )


def read_local_env_file() -> dict[str, str]:
    if not ENV_FILE_PATH.exists():
        return {}

    values: dict[str, str] = {}
    for raw_line in ENV_FILE_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", maxsplit=1)
        values[key.strip()] = value.strip().strip("\"'")
    return values


def get_spotify_oauth(settings: SpotifySettings) -> SpotifyOAuth:
    return SpotifyOAuth(
        client_id=settings.client_id,
        client_secret=settings.client_secret,
        redirect_uri=settings.redirect_uri,
        scope=SPOTIFY_SCOPE,
        cache_handler=MemoryCacheHandler(),
        open_browser=False,
    )


def build_authorize_url(return_to: str | None) -> str:
    settings = get_spotify_settings()
    oauth = get_spotify_oauth(settings)
    state = create_state_token(settings.client_secret, normalize_return_to(return_to))
    return oauth.get_authorize_url(state=state)


def exchange_code_for_recent_tracks(code: str) -> list[SpotifyRecentTrack]:
    settings = get_spotify_settings()
    oauth = get_spotify_oauth(settings)

    token_info = oauth.get_access_token(code=code, check_cache=False)
    access_token = token_info["access_token"]
    spotify = Spotify(auth=access_token)
    payload = spotify.current_user_recently_played(limit=50)
    return parse_recent_tracks(payload.get("items", []))


def import_recent_tracks(session: Session, tracks: list[SpotifyRecentTrack]) -> ImportedListeningSummary:
    imported_count = 0
    skipped_count = 0

    for track in tracks:
        performance = get_or_create_performance(session, track)
        if listening_event_exists(session, performance.id, track):
            skipped_count += 1
            continue

        session.add(
            ListeningEvent(
                performance_id=performance.id,
                listened_at=track.listened_at,
                ms_played=track.ms_played,
                platform="spotify",
                track_name=track.track_name,
                artist_name=track.artist_name,
                album_name=track.album_name,
            )
        )
        imported_count += 1

    session.commit()
    return ImportedListeningSummary(
        imported_count=imported_count,
        skipped_count=skipped_count,
    )


def resolve_return_to(state: str | None) -> str:
    settings = get_spotify_settings()
    if not state:
        return DEFAULT_FRONTEND_URL

    payload = parse_state_token(settings.client_secret, state)
    return normalize_return_to(payload.get("return_to"))


def parse_recent_tracks(items: list[dict[str, Any]]) -> list[SpotifyRecentTrack]:
    parsed_tracks: list[SpotifyRecentTrack] = []
    for item in items:
        track = item.get("track") or {}
        artists = track.get("artists") or []
        artist_name = ", ".join(artist["name"] for artist in artists if artist.get("name")) or "Unknown artist"
        album = track.get("album") or {}
        listened_at = parse_spotify_datetime(item["played_at"])
        ms_played = int(track.get("duration_ms") or 0)

        parsed_tracks.append(
            SpotifyRecentTrack(
                listened_at=listened_at,
                ms_played=ms_played,
                track_name=track.get("name") or "Unknown track",
                artist_name=artist_name,
                album_name=album.get("name") or "Unknown album",
                spotify_uri=track.get("uri"),
            )
        )

    return parsed_tracks


def get_or_create_performance(session: Session, track: SpotifyRecentTrack) -> Performance:
    performance = None
    if track.spotify_uri:
        performance = session.scalar(
            select(Performance).where(Performance.spotify_uri == track.spotify_uri)
        )

    if performance is None:
        performance = session.scalar(
            select(Performance).where(
                Performance.spotify_track_name == track.track_name,
                Performance.pianist == track.artist_name,
                Performance.album_name == track.album_name,
            )
        )

    if performance is not None:
        if not performance.spotify_uri and track.spotify_uri:
            performance.spotify_uri = track.spotify_uri
        return performance

    performance = Performance(
        composer=infer_composer(track.track_name),
        work_title=track.track_name,
        pianist=track.artist_name,
        album_name=track.album_name,
        spotify_track_name=track.track_name,
        spotify_uri=track.spotify_uri,
        source_confidence=0.25,
        notes="Imported from the Spotify recently played API.",
    )
    session.add(performance)
    session.flush()
    return performance


def listening_event_exists(session: Session, performance_id: int, track: SpotifyRecentTrack) -> bool:
    existing_event_id = session.scalar(
        select(ListeningEvent.id).where(
            ListeningEvent.performance_id == performance_id,
            ListeningEvent.listened_at == track.listened_at,
            ListeningEvent.track_name == track.track_name,
            ListeningEvent.artist_name == track.artist_name,
            ListeningEvent.album_name == track.album_name,
            ListeningEvent.platform == "spotify",
        )
    )
    return existing_event_id is not None


def infer_composer(track_name: str) -> str:
    if ":" in track_name:
        prefix = track_name.split(":", 1)[0].strip()
        if prefix:
            return prefix
    return "Unknown composer"


def parse_spotify_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def normalize_return_to(return_to: str | None) -> str:
    if not return_to:
        return DEFAULT_FRONTEND_URL

    parsed = urlparse(return_to)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return DEFAULT_FRONTEND_URL
    return return_to


def create_state_token(secret: str, return_to: str) -> str:
    payload = json.dumps({"return_to": return_to}, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).digest()
    return ".".join(
        (
            urlsafe_b64encode(payload),
            urlsafe_b64encode(signature),
        )
    )


def parse_state_token(secret: str, token: str) -> dict[str, str]:
    try:
        payload_segment, signature_segment = token.split(".", maxsplit=1)
        payload = urlsafe_b64decode(payload_segment)
        signature = urlsafe_b64decode(signature_segment)
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Invalid Spotify OAuth state.") from exc

    expected_signature = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected_signature):
        raise HTTPException(status_code=400, detail="Invalid Spotify OAuth state.")

    try:
        parsed = json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid Spotify OAuth state.") from exc

    return {"return_to": parsed.get("return_to", DEFAULT_FRONTEND_URL)}


def urlsafe_b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("utf-8").rstrip("=")


def urlsafe_b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(f"{value}{padding}")
