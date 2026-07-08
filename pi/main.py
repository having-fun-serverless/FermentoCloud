"""Configuration loaded from environment variables, and the CLI entrypoint."""
from __future__ import annotations

import logging
import os
import sys

from collector import Collector
from reading_queue import ReadingQueue
from sensor import DS18B20Sensor
from uploader import upload_reading


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    function_url = os.environ["FERMENTO_FUNCTION_URL"]
    region = os.environ.get("FERMENTO_AWS_REGION", "us-east-1")
    interval_seconds = int(os.environ.get("FERMENTO_INTERVAL_SECONDS", "120"))
    queue_db_path = os.environ.get("FERMENTO_QUEUE_DB_PATH", "/var/lib/fermento/queue.db")

    os.makedirs(os.path.dirname(queue_db_path), exist_ok=True)

    sensor = DS18B20Sensor()
    queue = ReadingQueue(queue_db_path)

    def uploader(timestamp: str, temperature_c: float) -> None:
        upload_reading(function_url, region, timestamp, temperature_c)

    collector = Collector(sensor=sensor, queue=queue, uploader=uploader, interval_seconds=interval_seconds)
    collector.run_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
