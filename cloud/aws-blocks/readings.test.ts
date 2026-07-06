import { test } from 'node:test';
import assert from 'node:assert';
import { parseReadingBody, putReading, ValidationError, parseListParams, listReadingsSince } from './readings.js';
import { readings, DEVICE_ID } from './index.js';

test('parseReadingBody accepts a valid body', () => {
  const result = parseReadingBody({ timestamp: '2026-07-06T12:00:00.000Z', temperatureC: 21.5 });
  assert.deepStrictEqual(result, { timestamp: '2026-07-06T12:00:00.000Z', temperatureC: 21.5 });
});

test('parseReadingBody rejects a missing timestamp with a ValidationError', () => {
  assert.throws(() => parseReadingBody({ temperatureC: 21.5 }), (err: unknown) => {
    assert.ok(err instanceof ValidationError);
    assert.match((err as Error).message, /timestamp/);
    return true;
  });
});

test('parseReadingBody rejects a non-numeric temperatureC', () => {
  assert.throws(
    () => parseReadingBody({ timestamp: '2026-07-06T12:00:00.000Z', temperatureC: 'warm' }),
    /temperatureC/,
  );
});

test('putReading stores a reading and returns 201', async () => {
  const result = await putReading(readings, DEVICE_ID, {
    timestamp: '2026-07-06T13:00:00.000Z',
    temperatureC: 22.1,
  });
  assert.strictEqual(result.statusCode, 201);
});

test('putReading rejects a malformed body with a ValidationError', async () => {
  await assert.rejects(
    () => putReading(readings, DEVICE_ID, { temperatureC: 22.1 }),
    (err: unknown) => err instanceof ValidationError,
  );
});

test('putReading lets a non-validation error from the table bubble up unchanged', async () => {
  const brokenTable = {
    put: async () => {
      throw new Error('DynamoDB is unavailable');
    },
  };
  await assert.rejects(
    () =>
      putReading(brokenTable, DEVICE_ID, {
        timestamp: '2026-07-06T13:00:00.000Z',
        temperatureC: 22.1,
      }),
    (err: unknown) => !(err instanceof ValidationError) && (err as Error).message === 'DynamoDB is unavailable',
  );
});

test('parseListParams defaults since to ~24h ago and limit to 100 when absent', () => {
  const { since, limit } = parseListParams(new URLSearchParams());
  assert.strictEqual(limit, 100);
  assert.ok(Date.now() - Date.parse(since) >= 24 * 60 * 60 * 1000 - 5000);
});

test('parseListParams clamps an invalid limit to the default', () => {
  const { limit } = parseListParams(new URLSearchParams({ limit: 'not-a-number' }));
  assert.strictEqual(limit, 100);
});

test('listReadingsSince returns readings after "since", ascending, capped by limit', async () => {
  await putReading(readings, DEVICE_ID, { timestamp: '2026-06-01T00:00:00.000Z', temperatureC: 20 });
  await putReading(readings, DEVICE_ID, { timestamp: '2026-06-02T00:00:00.000Z', temperatureC: 21 });
  await putReading(readings, DEVICE_ID, { timestamp: '2026-06-03T00:00:00.000Z', temperatureC: 22 });

  const result = await listReadingsSince(
    readings,
    DEVICE_ID,
    new URLSearchParams({ since: '2026-06-01T12:00:00.000Z', limit: '10' }),
  );
  assert.strictEqual(result.statusCode, 200);
  const body = result.body as { readings: Array<{ timestamp: string }> };
  const timestamps = body.readings.map((r) => r.timestamp);
  assert.deepStrictEqual(timestamps, ['2026-06-02T00:00:00.000Z', '2026-06-03T00:00:00.000Z']);
});
