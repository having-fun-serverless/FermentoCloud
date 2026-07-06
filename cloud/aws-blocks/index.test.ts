import { test } from 'node:test';
import assert from 'node:assert';
import { readings, DEVICE_ID } from './index.js';

test('readings table stores and retrieves an item by key', async () => {
  const item = {
    deviceId: DEVICE_ID,
    timestamp: '2026-07-06T12:00:00.000Z',
    metric: 'temperature' as const,
    value: 21.5,
  };
  await readings.put(item);
  const found = await readings.get({ deviceId: DEVICE_ID, timestamp: item.timestamp });
  assert.deepStrictEqual(found, item);
});
