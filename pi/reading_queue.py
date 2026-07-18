"""Local durable retry queue for temperature readings, backed by SQLite."""
from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass


@dataclass
class PendingReading:
    id: int
    timestamp: str
    temperature_c: float


class ReadingQueue:
    def __init__(self, db_path: str, max_age_seconds: int = 7 * 24 * 60 * 60):
        self._max_age_seconds = max_age_seconds
        self._conn = sqlite3.connect(db_path)
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS pending_readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                temperature_c REAL NOT NULL,
                enqueued_at REAL NOT NULL
            )
            """
        )
        self._conn.commit()

    def enqueue(self, timestamp: str, temperature_c: float) -> None:
        self._conn.execute(
            "INSERT INTO pending_readings (timestamp, temperature_c, enqueued_at) VALUES (?, ?, ?)",
            (timestamp, temperature_c, time.time()),
        )
        self._conn.commit()
        self._evict_stale()

    def _evict_stale(self) -> None:
        cutoff = time.time() - self._max_age_seconds
        self._conn.execute("DELETE FROM pending_readings WHERE enqueued_at < ?", (cutoff,))
        self._conn.commit()

    def pending(self) -> list[PendingReading]:
        rows = self._conn.execute(
            "SELECT id, timestamp, temperature_c FROM pending_readings ORDER BY id ASC"
        ).fetchall()
        return [PendingReading(id=r[0], timestamp=r[1], temperature_c=r[2]) for r in rows]

    def remove(self, reading_id: int) -> None:
        self._conn.execute("DELETE FROM pending_readings WHERE id = ?", (reading_id,))
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()
