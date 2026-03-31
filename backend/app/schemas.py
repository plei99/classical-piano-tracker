from datetime import datetime

from pydantic import BaseModel, ConfigDict


class HealthResponse(BaseModel):
    status: str


class StatsResponse(BaseModel):
    total_listens: int
    total_performances: int
    composers_tracked: int
    total_minutes: float


class PerformanceSummary(BaseModel):
    id: int
    composer: str
    work_title: str
    pianist: str
    album_name: str
    spotify_track_name: str
    source_confidence: float
    listen_count: int
    total_minutes: float
    last_heard_at: datetime | None


class ListeningEventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    listened_at: datetime
    ms_played: int
    platform: str
    track_name: str
    artist_name: str
    album_name: str
    performance_id: int
    composer: str
    work_title: str
    pianist: str


class DashboardResponse(BaseModel):
    stats: StatsResponse
    top_performances: list[PerformanceSummary]
    recent_listens: list[ListeningEventRead]

