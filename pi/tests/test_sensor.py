import pytest

from sensor import DS18B20Sensor, FakeSensor, SensorReadError

GOOD_READING = "3d 01 4b 46 7f ff 0d 10 41 : crc=41 YES\n3d 01 4b 46 7f ff 0d 10 41 t=21812\n"
BAD_CRC_READING = "3d 01 4b 46 7f ff 0d 10 41 : crc=41 NO\n3d 01 4b 46 7f ff 0d 10 41 t=21812\n"


def test_ds18b20_parses_a_good_reading(tmp_path):
    device_dir = tmp_path / "28-000001"
    device_dir.mkdir()
    (device_dir / "w1_slave").write_text(GOOD_READING)

    sensor = DS18B20Sensor(device_id="28-000001", base_path=str(tmp_path))
    assert sensor.read() == pytest.approx(21.812)


def test_ds18b20_raises_on_bad_crc(tmp_path):
    device_dir = tmp_path / "28-000001"
    device_dir.mkdir()
    (device_dir / "w1_slave").write_text(BAD_CRC_READING)

    sensor = DS18B20Sensor(device_id="28-000001", base_path=str(tmp_path))
    with pytest.raises(SensorReadError):
        sensor.read()


def test_ds18b20_raises_when_device_missing(tmp_path):
    sensor = DS18B20Sensor(device_id="28-nonexistent", base_path=str(tmp_path))
    with pytest.raises(SensorReadError):
        sensor.read()


def test_fake_sensor_returns_configured_value():
    sensor = FakeSensor(value=19.5)
    assert sensor.read() == 19.5


def test_fake_sensor_raises_configured_error():
    sensor = FakeSensor(error=SensorReadError("boom"))
    with pytest.raises(SensorReadError):
        sensor.read()
