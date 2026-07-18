import { test } from 'node:test';
import assert from 'node:assert';
import { signedFetch, unsignedFetch } from './sigv4.js';

const FUNCTION_URL = process.env.FERMENTO_E2E_FUNCTION_URL;
if (!FUNCTION_URL) {
  throw new Error('FERMENTO_E2E_FUNCTION_URL must be set to the e2e stack\'s Function URL output');
}

test('signed POST then GET round-trips a reading', async () => {
  const timestamp = new Date().toISOString();
  const post = await signedFetch('POST', FUNCTION_URL, '/readings', {
    body: { timestamp, temperatureC: 20.25 },
  });
  assert.strictEqual(post.status, 201);

  const since = new Date(Date.now() - 60_000).toISOString();
  const get = await signedFetch('GET', FUNCTION_URL, '/readings', { query: { since } });
  assert.strictEqual(get.status, 200);
  const body = get.body as { readings: Array<{ timestamp: string; value: number }> };
  const match = body.readings.find((r) => r.timestamp === timestamp);
  assert.ok(match, 'uploaded reading should be returned by GET /readings');
  assert.strictEqual(match?.value, 20.25);
});

test('a malformed POST body gets 400', async () => {
  const result = await signedFetch('POST', FUNCTION_URL, '/readings', {
    body: { temperatureC: 20.25 }, // missing timestamp
  });
  assert.strictEqual(result.status, 400);
});

test('an unsigned request gets 403', async () => {
  const result = await unsignedFetch('POST', FUNCTION_URL, '/readings', {
    timestamp: new Date().toISOString(),
    temperatureC: 20.25,
  });
  assert.strictEqual(result.status, 403);
});
