from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import ListeningEvent, Performance


def seed_sample_data(session: Session) -> None:
    existing = session.scalar(select(Performance.id).limit(1))
    if existing is not None:
        return

    performances = [
        Performance(
            composer="J. S. Bach",
            work_title="Goldberg Variations, BWV 988: Aria",
            pianist="Andras Schiff",
            album_name="Bach: Goldberg Variations",
            spotify_track_name="Goldberg Variations, BWV 988: Aria",
            spotify_uri="spotify:track:bach-goldberg-aria",
            source_confidence=0.95,
            notes="Canonical opening aria used as seeded demo data.",
        ),
        Performance(
            composer="Frederic Chopin",
            work_title="Ballade No. 1 in G minor, Op. 23",
            pianist="Krystian Zimerman",
            album_name="Chopin: Ballades",
            spotify_track_name="Ballade No. 1 in G minor, Op. 23",
            spotify_uri="spotify:track:chopin-ballade-1",
            source_confidence=0.98,
            notes="Sample mapping for a frequently replayed favorite.",
        ),
        Performance(
            composer="Claude Debussy",
            work_title="Suite bergamasque, L. 75: III. Clair de lune",
            pianist="Seong-Jin Cho",
            album_name="Debussy",
            spotify_track_name="Suite bergamasque, L. 75: III. Clair de lune",
            spotify_uri="spotify:track:debussy-clair-de-lune",
            source_confidence=0.94,
            notes="Sample mapping for lyrical late-evening listening.",
        ),
    ]

    session.add_all(performances)
    session.flush()

    now = datetime.now(timezone.utc).replace(microsecond=0)
    events = [
        ListeningEvent(
            performance_id=performances[0].id,
            listened_at=now - timedelta(days=7, hours=2),
            ms_played=185000,
            platform="spotify",
            track_name=performances[0].spotify_track_name,
            artist_name=performances[0].pianist,
            album_name=performances[0].album_name,
        ),
        ListeningEvent(
            performance_id=performances[0].id,
            listened_at=now - timedelta(days=1, hours=1),
            ms_played=191000,
            platform="spotify",
            track_name=performances[0].spotify_track_name,
            artist_name=performances[0].pianist,
            album_name=performances[0].album_name,
        ),
        ListeningEvent(
            performance_id=performances[1].id,
            listened_at=now - timedelta(days=6, hours=4),
            ms_played=549000,
            platform="spotify",
            track_name=performances[1].spotify_track_name,
            artist_name=performances[1].pianist,
            album_name=performances[1].album_name,
        ),
        ListeningEvent(
            performance_id=performances[1].id,
            listened_at=now - timedelta(days=3, minutes=35),
            ms_played=543000,
            platform="spotify",
            track_name=performances[1].spotify_track_name,
            artist_name=performances[1].pianist,
            album_name=performances[1].album_name,
        ),
        ListeningEvent(
            performance_id=performances[2].id,
            listened_at=now - timedelta(days=2, hours=5),
            ms_played=298000,
            platform="spotify",
            track_name=performances[2].spotify_track_name,
            artist_name=performances[2].pianist,
            album_name=performances[2].album_name,
        ),
        ListeningEvent(
            performance_id=performances[2].id,
            listened_at=now - timedelta(hours=6),
            ms_played=301000,
            platform="spotify",
            track_name=performances[2].spotify_track_name,
            artist_name=performances[2].pianist,
            album_name=performances[2].album_name,
        ),
    ]

    session.add_all(events)
    session.commit()

