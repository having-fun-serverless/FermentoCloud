from reading_queue import ReadingQueue
from sensor import FakeSensor, SensorReadError
from collector import Collector
from uploader import UploadError


def make_collector(tmp_path, sensor, uploader):
    queue = ReadingQueue(str(tmp_path / "queue.db"))
    return Collector(sensor=sensor, queue=queue, uploader=uploader, interval_seconds=1), queue


def test_tick_enqueues_and_uploads_a_good_reading(tmp_path):
    uploaded = []
    collector, queue = make_collector(
        tmp_path,
        sensor=FakeSensor(value=21.5),
        uploader=lambda ts, temp: uploaded.append((ts, temp)),
    )

    collector.tick()

    assert len(uploaded) == 1
    assert uploaded[0][1] == 21.5
    assert queue.pending() == []


def test_tick_skips_enqueue_on_sensor_failure(tmp_path):
    uploaded = []
    collector, queue = make_collector(
        tmp_path,
        sensor=FakeSensor(error=SensorReadError("bad crc")),
        uploader=lambda ts, temp: uploaded.append((ts, temp)),
    )

    collector.tick()

    assert uploaded == []
    assert queue.pending() == []


def test_tick_leaves_reading_queued_on_upload_failure(tmp_path):
    def failing_uploader(ts, temp):
        raise UploadError("network down")

    collector, queue = make_collector(tmp_path, sensor=FakeSensor(value=21.5), uploader=failing_uploader)

    collector.tick()

    pending = queue.pending()
    assert len(pending) == 1
    assert pending[0].temperature_c == 21.5


def test_tick_stops_flushing_at_first_failure_preserving_order(tmp_path):
    queue = ReadingQueue(str(tmp_path / "queue.db"))
    queue.enqueue("2026-07-06T12:00:00.000Z", 20.0)
    queue.enqueue("2026-07-06T12:02:00.000Z", 20.5)

    attempts = []

    def uploader(ts, temp):
        attempts.append(ts)
        raise UploadError("network down")

    collector = Collector(
        sensor=FakeSensor(error=SensorReadError("no reading this tick")),
        queue=queue,
        uploader=uploader,
    )
    collector.tick()

    assert attempts == ["2026-07-06T12:00:00.000Z"]
    assert len(queue.pending()) == 2
