"""Main collector loop: reads the sensor, queues, and uploads readings."""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

from reading_queue import ReadingQueue
from sensor import SensorReadError, TemperatureSensor
from uploader import UploadError

logger = logging.getLogger("fermento.collector")


class Collector:
    def __init__(
        self,
        sensor: TemperatureSensor,
        queue: ReadingQueue,
        uploader,
        interval_seconds: int = 120,
    ):
        self._sensor = sensor
        self._queue = queue
        self._uploader = uploader
        self._interval_seconds = interval_seconds

    def tick(self) -> None:
        """Read the sensor once, enqueue on success, then flush the queue."""
        try:
            temperature_c = self._sensor.read()
        except SensorReadError as e:
            logger.warning("Sensor read failed, skipping this tick: %s", e)
        else:
            timestamp = (
                datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            )
            self._queue.enqueue(timestamp, temperature_c)

        self._flush_queue()

    def _flush_queue(self) -> None:
        for reading in self._queue.pending():
            try:
                self._uploader(reading.timestamp, reading.temperature_c)
            except UploadError as e:
                logger.warning("Upload failed, will retry next tick: %s", e)
                return
            self._queue.remove(reading.id)

    def run_forever(self) -> None:
        while True:
            self.tick()
            time.sleep(self._interval_seconds)
