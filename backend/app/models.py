from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Performance(Base):
    __tablename__ = "performances"

    id: Mapped[int] = mapped_column(primary_key=True)
    composer: Mapped[str] = mapped_column(String(120), index=True)
    work_title: Mapped[str] = mapped_column(String(255), index=True)
    pianist: Mapped[str] = mapped_column(String(120), index=True)
    album_name: Mapped[str] = mapped_column(String(255))
    spotify_track_name: Mapped[str] = mapped_column(String(255))
    spotify_uri: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    source_confidence: Mapped[float] = mapped_column(Float, default=0.0)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    listening_events: Mapped[list["ListeningEvent"]] = relationship(
        back_populates="performance",
        cascade="all, delete-orphan",
    )


class ListeningEvent(Base):
    __tablename__ = "listening_events"
    __table_args__ = (
        Index("ix_listening_events_listened_at", "listened_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    performance_id: Mapped[int] = mapped_column(ForeignKey("performances.id"), index=True)
    listened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    ms_played: Mapped[int] = mapped_column(Integer)
    platform: Mapped[str] = mapped_column(String(80), default="spotify")
    track_name: Mapped[str] = mapped_column(String(255))
    artist_name: Mapped[str] = mapped_column(String(255))
    album_name: Mapped[str] = mapped_column(String(255))

    performance: Mapped[Performance] = relationship(back_populates="listening_events")

