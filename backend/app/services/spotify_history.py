from datetime import datetime

from pydantic import BaseModel, Field


class SpotifyStreamRecord(BaseModel):
    listened_at: datetime = Field(alias="ts")
    ms_played: int
    platform: str = "spotify"
    track_name: str | None = Field(default=None, alias="master_metadata_track_name")
    artist_name: str | None = Field(default=None, alias="master_metadata_album_artist_name")
    album_name: str | None = Field(default=None, alias="master_metadata_album_album_name")
    spotify_track_uri: str | None = None


def parse_streaming_history(payload: list[dict]) -> list[SpotifyStreamRecord]:
    return [SpotifyStreamRecord.model_validate(item) for item in payload]
