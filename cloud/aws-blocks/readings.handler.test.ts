import { test } from 'node:test';
import assert from 'node:assert';
import type { Context } from 'aws-lambda';
import { handler } from './readings.handler.js';

// Minimal Lambda Function URL event (API Gateway v2 payload format).
function makeEvent(method: string, path: string, body?: string) {
  const [rawPath, rawQueryString = ''] = path.split('?');
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString,
    headers: { 'content-type': 'application/json' },
    requestContext: {
      http: { method, path: rawPath, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'test-request',
      routeKey: '$default',
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body,
    isBase64Encoded: false,
  };
}

const fakeContext = {} as Context;

test('POST /readings via the handler stores a reading and returns 201', async () => {
  const event = makeEvent(
    'POST',
    '/readings',
    JSON.stringify({ timestamp: '2026-07-06T14:00:00.000Z', temperatureC: 19.5 }),
  );
  const result = (await handler(event, fakeContext)) as { statusCode: number };
  assert.strictEqual(result.statusCode, 201);
});

test('POST /readings via the handler with a malformed body returns 400', async () => {
  const event = makeEvent('POST', '/readings', JSON.stringify({ temperatureC: 19.5 }));
  const result = (await handler(event, fakeContext)) as { statusCode: number };
  assert.strictEqual(result.statusCode, 400);
});

test('GET /readings via the handler returns 200 with a readings array', async () => {
  const event = makeEvent('GET', '/readings?since=2026-01-01T00:00:00.000Z');
  const result = (await handler(event, fakeContext)) as { statusCode: number; body: string };
  assert.strictEqual(result.statusCode, 200);
  const body = JSON.parse(result.body) as { readings: unknown[] };
  assert.ok(Array.isArray(body.readings));
});
