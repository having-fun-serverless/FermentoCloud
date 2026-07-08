from reading_queue import ReadingQueue


def test_enqueue_then_pending_returns_the_reading(tmp_path):
    q = ReadingQueue(str(tmp_path / "queue.db"))
    q.enqueue("2026-07-06T12:00:00.000Z", 21.5)

    pending = q.pending()
    assert len(pending) == 1
    assert pending[0].timestamp == "2026-07-06T12:00:00.000Z"
    assert pending[0].temperature_c == 21.5


def test_remove_deletes_only_that_reading(tmp_path):
    q = ReadingQueue(str(tmp_path / "queue.db"))
    q.enqueue("2026-07-06T12:00:00.000Z", 21.5)
    q.enqueue("2026-07-06T12:02:00.000Z", 21.7)

    first_id = q.pending()[0].id
    q.remove(first_id)

    remaining = q.pending()
    assert len(remaining) == 1
    assert remaining[0].temperature_c == 21.7


def test_pending_survives_reopening_the_same_db_file(tmp_path):
    db_path = str(tmp_path / "queue.db")
    q1 = ReadingQueue(db_path)
    q1.enqueue("2026-07-06T12:00:00.000Z", 21.5)
    q1.close()

    q2 = ReadingQueue(db_path)
    assert len(q2.pending()) == 1


def test_evicts_readings_older_than_max_age(tmp_path, monkeypatch):
    import time as time_module

    q = ReadingQueue(str(tmp_path / "queue.db"), max_age_seconds=100)

    fake_now = [1_000_000.0]
    monkeypatch.setattr(time_module, "time", lambda: fake_now[0])

    q.enqueue("2026-07-06T12:00:00.000Z", 21.5)
    fake_now[0] += 200  # now older than max_age_seconds

    q.enqueue("2026-07-06T12:05:00.000Z", 21.6)

    remaining = q.pending()
    assert len(remaining) == 1
    assert remaining[0].temperature_c == 21.6
