"""Temperature sensor abstraction for the DS18B20 1-Wire probe."""
from __future__ import annotations

import glob


class SensorReadError(Exception):
    """Raised when a temperature reading cannot be obtained."""


class TemperatureSensor:
    def read(self) -> float:
        raise NotImplementedError


class FakeSensor(TemperatureSensor):
    """Test double: returns a preset value, or raises a preset error."""

    def __init__(self, value: float | None = None, error: Exception | None = None):
        self._value = value
        self._error = error

    def read(self) -> float:
        if self._error is not None:
            raise self._error
        if self._value is None:
            raise SensorReadError("FakeSensor has no value configured")
        return self._value


class DS18B20Sensor(TemperatureSensor):
    """Reads a DS18B20 probe via the Linux 1-Wire kernel driver."""

    def __init__(self, device_id: str | None = None, base_path: str = "/sys/bus/w1/devices"):
        self._base_path = base_path
        self._device_id = device_id

    def _device_path(self) -> str:
        if self._device_id:
            return f"{self._base_path}/{self._device_id}/w1_slave"
        matches = glob.glob(f"{self._base_path}/28-*/w1_slave")
        if not matches:
            raise SensorReadError(f"No DS18B20 device found under {self._base_path}")
        return matches[0]

    def read(self) -> float:
        path = self._device_path()
        try:
            with open(path, "r") as f:
                lines = f.readlines()
        except OSError as e:
            raise SensorReadError(f"Could not read {path}: {e}") from e

        if len(lines) < 2 or not lines[0].strip().endswith("YES"):
            raise SensorReadError(f"Bad CRC in {path}: {lines}")

        marker = "t="
        idx = lines[1].find(marker)
        if idx == -1:
            raise SensorReadError(f"No temperature value found in {path}: {lines[1]}")

        raw = lines[1][idx + len(marker):].strip()
        try:
            millidegrees = int(raw)
        except ValueError as e:
            raise SensorReadError(f"Could not parse temperature value {raw!r}") from e

        return millidegrees / 1000.0
