# FermentoCloud Temperature Pipeline (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get a Raspberry Pi's DS18B20 temperature readings into a serverless AWS backend end-to-end, with an IAM-authenticated read API an external agent can poll, an isolated e2e test environment, and three operational Claude Code skills.

**Architecture:** A Python collector on the Pi reads the sensor, buffers readings in local SQLite, and SigV4-signs POSTs to a hand-written AWS Lambda behind an IAM-authenticated Function URL (built with AWS Blocks + a CDK-layer escape hatch + AWS Lambda Powertools' HTTP router), which stores/queries readings in a `DistributedTable` (DynamoDB).

**Tech Stack:** AWS Blocks (TypeScript, CDK v2), `@aws-lambda-powertools/event-handler`, Node's built-in `node:test` runner (via `tsx`), Python 3 + boto3/botocore + requests + pytest, systemd.

## Global Constraints

- Node.js **>=22** is required by the AWS Blocks scaffold (`package.json` sets `"engines": {"node": ">=22.0.0"}`). If the active Node is older, install/switch to Node 22+ before Task 1 (e.g. via `nvm install 22 && nvm use 22`). A scaffold run under Node 20 emits an `EBADENGINE` warning but does not hard-fail; do not rely on that — use Node 22+.
- Test convention for `cloud/`: Node's built-in `node:test` + `node:assert`, executed via `tsx --test <path>` — this matches the scaffold's own generated test file, not vitest/jest.
- All local (non-deployed) code in `cloud/` that imports a `DistributedTable` instance resolves to its in-memory mock automatically (this is the package's `default` export condition) — no flags needed for `npm test`.
- The deployed Lambda **must** be bundled with esbuild condition `aws-runtime` (`bundling: { esbuildArgs: { '--conditions': 'aws-runtime' } } }` on the CDK `NodejsFunction`) or it will silently run against the in-memory mock instead of real DynamoDB in production. This is confirmed by inspecting `@aws-blocks/core/dist/cdk/blocks-backend.js`, which does exactly this for the framework's own Lambda.
- `DistributedTable` key config uses `{ partitionKey, sortKey }` (not `{ partition, sort }`) and query conditions use `{ fieldName: { equals: v } }` / `{ fieldName: { greaterThan: v } }` etc. — confirmed from the installed package's `src/types.ts`.
- Temperature is always Celsius; no unit field is stored (per approved spec).
- `deviceId` is a fixed server-side constant (`"fermenter-1"`), never sent by the Pi.
- Per [AWS Blocks best practices](https://docs.aws.amazon.com/blocks/latest/devguide/best-practices.html): keep the IFC layer (`index.ts`) thin (Block instantiations only, no business logic); use named error classes (e.g. `ValidationError`), never generic `Error`, so only genuine validation failures become 400s and unexpected errors still bubble up to a 500 instead of being masked; extract business logic into functions that take Block instances as explicit parameters rather than importing module-level singletons, so tests can pass in either the real (locally-mocked) table or a broken fake.

---

## File Structure

```
cloud/                              (AWS Blocks TypeScript app; its own npm project root)
  package.json
  aws-blocks/
    index.ts                        Scope + DEVICE_ID + Logger + readings DistributedTable
    index.test.ts                   round-trip test for the table wiring
    index.cdk.ts                    CDK layer: custom Lambda + Function URL (AWS_IAM) + IAM users
    index.handler.ts                (kept from scaffold; unused lambda-lith, harmless)
    readings.ts                     pure business logic: parse/validate, put, list
    readings.test.ts                unit tests for readings.ts (local mock table)
    readings.handler.ts             Powertools Router wiring; the actual Lambda entry point
    readings.handler.test.ts        tests the handler via synthetic Function URL events
  e2e/
    sigv4.ts                        SigV4 signing helper for e2e HTTP calls
    clear-table.ts                  wipes the e2e table before a run
    readings.e2e.test.ts            e2e suite against the real deployed e2e stack

pi/                                 (Python collector; its own project root)
  requirements.txt
  requirements-dev.txt
  sensor.py                         TemperatureSensor, DS18B20Sensor, FakeSensor
  reading_queue.py                  ReadingQueue (SQLite retry buffer)
  uploader.py                       SigV4-signed upload_reading()
  collector.py                      Collector (main loop)
  main.py                           CLI entrypoint (env config, wires real dependencies)
  tests/
    test_sensor.py
    test_reading_queue.py
    test_uploader.py
    test_collector.py
  systemd/
    fermento-collector.service
  .env.example
  README.md

.claude/skills/
  deploy/SKILL.md
  run-e2e/SKILL.md
  read-fermento-api/SKILL.md
```

---

### Task 1: Scaffold the cloud project and strip unused frontend scaffolding

**Files:**
- Create: `cloud/` (via `npm create`)
- Delete: `cloud/src/index.ts`, `cloud/index.html`, `cloud/vite.config.ts`, `cloud/test/e2e.test.ts`
- Modify: `cloud/package.json`, `cloud/aws-blocks/index.cdk.ts`

**Interfaces:**
- Produces: a working `cloud/` npm project with `typecheck`, `test`, `test:e2e`, `deploy`, `destroy`, `sandbox`, `sandbox:destroy` scripts, and no frontend code.

- [ ] **Step 1: Confirm Node 22+ is active**

Run: `node --version`
Expected: `v22.x.x` or higher. If not, run `nvm install 22 && nvm use 22` first (or your platform's equivalent).

- [ ] **Step 2: Scaffold the project**

Run from the repo root:
```bash
npm create @aws-blocks/blocks-app@latest cloud -- --yes
```
Expected: `✓ Blocks app created!` printed, and a `cloud/` directory now exists containing `aws-blocks/`, `src/`, `test/`, `package.json`, `cdk.json`, `.blocks/config.json`.

- [ ] **Step 3: Sanity-check the pristine scaffold typechecks**

Run: `cd cloud && npm run typecheck`
Expected: exits 0 with no errors.

- [ ] **Step 4: Delete unused frontend and template-test files**

```bash
rm -rf cloud/src cloud/index.html cloud/vite.config.ts cloud/test
```

- [ ] **Step 5: Trim `cloud/package.json` to drop frontend-only scripts and add our own test scripts**

Edit `cloud/package.json`'s `"scripts"` block to:
```json
{
  "typecheck": "tsc --noEmit",
  "test": "tsx --test aws-blocks",
  "test:e2e": "tsx --test e2e",
  "sandbox": "tsx aws-blocks/scripts/sandbox.ts",
  "sandbox:destroy": "tsx -C cdk aws-blocks/scripts/sandbox-destroy.ts",
  "sandbox:console": "tsx aws-blocks/scripts/console.ts",
  "cleanup": "tsx aws-blocks/scripts/cleanup.ts",
  "deploy": "tsx aws-blocks/scripts/deploy.ts",
  "destroy": "tsx aws-blocks/scripts/destroy.ts"
}
```
Remove the `"dev"`, `"dev:server"`, `"build"`, `"preview"`, `"spec"`, `"vendorize"` scripts and the `"lit-html"` dependency (no frontend exists in this project). Leave `"workspaces": ["aws-blocks"]` as-is — it's harmless and other scripts rely on the existing workspace layout.

- [ ] **Step 6: Remove the `Hosting` construct from the CDK layer (no frontend to host)**

In `cloud/aws-blocks/index.cdk.ts`, delete the import of `Hosting` and this whole block:
```typescript
if (!sandboxMode) {
  new Hosting(blocksStack, 'Hosting', {
    root: join(__dirname, '..'),
    buildCommand: 'npm run build',
    buildOutputDir: 'dist',
    api: blocksStack
  });
}
```
Also remove `Hosting` from the `import { Hosting, BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';` line, leaving `import { BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';`.

- [ ] **Step 7: Verify typecheck still passes after cleanup**

Run: `cd cloud && npm run typecheck`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add cloud
git commit -m "$(cat <<'EOF'
Scaffold AWS Blocks cloud project, strip unused frontend

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Define the readings table in the IFC layer

**Files:**
- Modify: `cloud/aws-blocks/index.ts` (replace the scaffold's todo-app content entirely)
- Test: `cloud/aws-blocks/index.test.ts`

**Interfaces:**
- Produces: `export const scope: Scope`, `export const DEVICE_ID: string`, `export const logger: Logger`, `export const readings: DistributedTable<Reading>`, `export type Reading = { deviceId: string; timestamp: string; metric: 'temperature'; value: number }`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test**

Create `cloud/aws-blocks/index.test.ts`:
```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cloud && npx tsx --test aws-blocks/index.test.ts`
Expected: FAIL — `index.ts` still exports the scaffold's todo-app shape, not `readings`/`DEVICE_ID`.

- [ ] **Step 3: Replace `cloud/aws-blocks/index.ts`**

```typescript
/**
 * Backend — aws-blocks/index.ts
 *
 * FermentoCloud Phase 1: temperature readings storage. No ApiNamespace here —
 * the read/write API is a hand-written Lambda behind an IAM-authenticated
 * Function URL, defined in index.cdk.ts and readings.handler.ts, because the
 * callers (a Python script, an external agent) aren't a JS frontend and need
 * real IAM/SigV4 auth that ApiNamespace's shared-Lambda RPC model can't scope
 * per-route.
 */
import { Scope, DistributedTable, Logger } from '@aws-blocks/blocks';
import { z } from 'zod';

const scopeName = process.env.BLOCKS_ENV === 'e2e' ? 'fermento-e2e' : 'fermento-cloud';
export const scope = new Scope(scopeName);

/** Single bioreactor for now — a real key, not a hardcoded singleton row. */
export const DEVICE_ID = 'fermenter-1';

export const logger = new Logger(scope, 'logger', { level: 'info' });

const readingSchema = z.object({
  deviceId: z.string(),
  timestamp: z.string(),
  metric: z.literal('temperature'),
  value: z.number(),
});

export type Reading = z.infer<typeof readingSchema>;

export const readings = new DistributedTable(scope, 'readings', {
  schema: readingSchema,
  key: { partitionKey: 'deviceId', sortKey: 'timestamp' },
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd cloud && npx tsx --test aws-blocks/index.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Run typecheck**

Run: `cd cloud && npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add cloud/aws-blocks/index.ts cloud/aws-blocks/index.test.ts
git commit -m "$(cat <<'EOF'
Define readings DistributedTable and env-parameterized Scope

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Readings business logic — write path

**Files:**
- Create: `cloud/aws-blocks/readings.ts`
- Test: `cloud/aws-blocks/readings.test.ts`

**Interfaces:**
- Consumes: `Reading` type from `./index.js` (Task 2); the real `readings`/`DEVICE_ID` (Task 2) are passed in explicitly by tests and by the handler (Task 5), not imported as module-level singletons here.
- Produces: `class ValidationError extends Error`, `parseReadingBody(raw: unknown): { timestamp: string; temperatureC: number }` (throws `ValidationError` on invalid input), `putReading(table: Pick<DistributedTable<Reading>, 'put'>, deviceId: string, raw: unknown): Promise<HandlerResult>`.

- [ ] **Step 1: Write the failing tests**

Create `cloud/aws-blocks/readings.test.ts`:
```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { parseReadingBody, putReading, ValidationError } from './readings.js';
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cloud && npx tsx --test aws-blocks/readings.test.ts`
Expected: FAIL — `readings.ts` does not exist yet.

- [ ] **Step 3: Create `cloud/aws-blocks/readings.ts` (write path only)**

```typescript
import type { DistributedTable } from '@aws-blocks/blocks';
import type { Reading } from './index.js';

/** Named per AWS Blocks best practices — lets callers distinguish bad input from internal failures. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function parseReadingBody(raw: unknown): { timestamp: string; temperatureC: number } {
  if (typeof raw !== 'object' || raw === null) {
    throw new ValidationError('Body must be a JSON object');
  }
  const { timestamp, temperatureC } = raw as Record<string, unknown>;
  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
    throw new ValidationError('timestamp must be a valid ISO 8601 string');
  }
  if (typeof temperatureC !== 'number' || Number.isNaN(temperatureC)) {
    throw new ValidationError('temperatureC must be a number');
  }
  return { timestamp, temperatureC };
}

export interface HandlerResult {
  statusCode: number;
  body: unknown;
}

export async function putReading(
  table: Pick<DistributedTable<Reading>, 'put'>,
  deviceId: string,
  raw: unknown,
): Promise<HandlerResult> {
  const { timestamp, temperatureC } = parseReadingBody(raw);
  await table.put({
    deviceId,
    timestamp,
    metric: 'temperature',
    value: temperatureC,
  });
  return { statusCode: 201, body: { timestamp, temperatureC } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cloud && npx tsx --test aws-blocks/readings.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add cloud/aws-blocks/readings.ts cloud/aws-blocks/readings.test.ts
git commit -m "$(cat <<'EOF'
Add readings write-path business logic with validation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Readings business logic — read path

**Files:**
- Modify: `cloud/aws-blocks/readings.ts`
- Modify: `cloud/aws-blocks/readings.test.ts`

**Interfaces:**
- Consumes: `HandlerResult` (Task 3, same file); `Reading` type from `./index.js` (Task 2).
- Produces: `parseListParams(searchParams: URLSearchParams): { since: string; limit: number }`, `listReadingsSince(table: Pick<DistributedTable<Reading>, 'query'>, deviceId: string, searchParams: URLSearchParams): Promise<HandlerResult>`.

- [ ] **Step 1: Write the failing tests**

Append to `cloud/aws-blocks/readings.test.ts`:
```typescript
import { parseListParams, listReadingsSince } from './readings.js';

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
```
(Add the `parseListParams, listReadingsSince` names to the existing `import { ... } from './readings.js'` line at the top of the file instead of a second import statement.)

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd cloud && npx tsx --test aws-blocks/readings.test.ts`
Expected: FAIL on the three new tests — `parseListParams`/`listReadingsSince` don't exist yet.

- [ ] **Step 3: Add the read path to `cloud/aws-blocks/readings.ts`**

Append:
```typescript
const DEFAULT_LIMIT = 100;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_LIMIT = 1000;

export function parseListParams(searchParams: URLSearchParams): { since: string; limit: number } {
  const sinceParam = searchParams.get('since');
  const since =
    sinceParam && !Number.isNaN(Date.parse(sinceParam))
      ? sinceParam
      : new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();

  const limitParam = Number(searchParams.get('limit'));
  const limit =
    Number.isInteger(limitParam) && limitParam > 0 && limitParam <= MAX_LIMIT
      ? limitParam
      : DEFAULT_LIMIT;

  return { since, limit };
}

export async function listReadingsSince(
  table: Pick<DistributedTable<Reading>, 'query'>,
  deviceId: string,
  searchParams: URLSearchParams,
): Promise<HandlerResult> {
  const { since, limit } = parseListParams(searchParams);
  const items = [];
  for await (const item of table.query({
    where: {
      deviceId: { equals: deviceId },
      timestamp: { greaterThan: since },
    },
    limit,
    order: 'asc',
  })) {
    items.push(item);
  }
  return { statusCode: 200, body: { readings: items } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cloud && npx tsx --test aws-blocks/readings.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add cloud/aws-blocks/readings.ts cloud/aws-blocks/readings.test.ts
git commit -m "$(cat <<'EOF'
Add readings read-path query logic with since/limit defaults

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Lambda entrypoint — Powertools router wiring

**Files:**
- Create: `cloud/aws-blocks/readings.handler.ts`
- Test: `cloud/aws-blocks/readings.handler.test.ts`
- Modify: `cloud/package.json` (add `@aws-lambda-powertools/event-handler`, `aws-lambda`, `@types/aws-lambda` deps)

**Interfaces:**
- Consumes: `putReading`, `listReadingsSince`, `ValidationError` from `./readings.js` (Tasks 3, 4); `readings`, `DEVICE_ID`, `logger` from `./index.js` (Task 2).
- Produces: `export const handler: (event: unknown, context: Context) => Promise<unknown>`.

- [ ] **Step 1: Install dependencies**

Run: `cd cloud && npm install @aws-lambda-powertools/event-handler aws-lambda && npm install --save-dev @types/aws-lambda`
Expected: exits 0, `package.json` now lists these three.

- [ ] **Step 2: Write the failing tests**

Create `cloud/aws-blocks/readings.handler.test.ts`:
```typescript
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd cloud && npx tsx --test aws-blocks/readings.handler.test.ts`
Expected: FAIL — `readings.handler.ts` does not exist yet.

- [ ] **Step 4: Create `cloud/aws-blocks/readings.handler.ts`**

```typescript
import { Router, BadRequestError } from '@aws-lambda-powertools/event-handler/http';
import type { Context } from 'aws-lambda';
import { putReading, listReadingsSince, ValidationError } from './readings.js';
import { readings, DEVICE_ID, logger } from './index.js';

const app = new Router();

app.post('/readings', async ({ req }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new BadRequestError('Body must be valid JSON');
  }
  try {
    return await putReading(readings, DEVICE_ID, body);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new BadRequestError(error.message);
    }
    throw error; // not a validation problem — let it become a 500, don't mask it as a 400
  }
});

app.get('/readings', async ({ req }) => {
  const url = new URL(req.url);
  return await listReadingsSince(readings, DEVICE_ID, url.searchParams);
});

export const handler = async (event: unknown, context: Context) => {
  try {
    return await app.resolve(event, context);
  } catch (error) {
    logger.error('Unhandled error in readings handler', { error: String(error) });
    throw error;
  }
};
```

**Note:** if `app.resolve` expects a different Function URL event shape than the one hand-built in the test, check `node_modules/@aws-lambda-powertools/event-handler`'s type definitions for the exact expected fields and adjust the test's `makeEvent` helper — don't change the handler to work around a wrong test fixture.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd cloud && npx tsx --test aws-blocks/readings.handler.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full local test suite and typecheck**

Run: `cd cloud && npm test && npm run typecheck`
Expected: all tests pass, typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add cloud/aws-blocks/readings.handler.ts cloud/aws-blocks/readings.handler.test.ts cloud/package.json cloud/package-lock.json
git commit -m "$(cat <<'EOF'
Wire readings routes with Powertools HTTP router

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: CDK layer — custom Lambda, Function URL, IAM identities, env-based stack naming

**Files:**
- Modify: `cloud/aws-blocks/index.cdk.ts`
- Modify: `cloud/package.json` (add `aws-cdk-lib` constructs already present as devDependency; add `esbuild` already present)

**Interfaces:**
- Consumes: `readings.handler.ts`'s `handler` export (Task 5) as a Lambda entry point (referenced by file path, not imported).
- Produces: a CloudFormation stack (on deploy) containing the `ReadingsHandler` Lambda, its Function URL, and two IAM users (`fermento-pi-writer`, `fermento-agent-reader`) each granted invoke access — prod only, not created in the e2e stack.

- [ ] **Step 1: Replace `cloud/aws-blocks/index.cdk.ts`**

```typescript
import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';

import { BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getStackId, getStackName } from '@aws-blocks/blocks/scripts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();
const isE2E = process.env.BLOCKS_ENV === 'e2e';

// Stack naming: sandbox uses Blocks' own per-machine sandbox id. Otherwise we
// pick prod vs e2e ourselves (Blocks' own getStackName only distinguishes
// sandbox/prod, with no third-environment concept), reusing the same stable
// project stackId so both stacks are clearly related in the AWS console.
const stackName = sandboxMode
  ? getStackName({ sandbox: true, projectRoot })
  : `${getStackId(projectRoot)}-${isE2E ? 'e2e' : 'prod'}`;

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
});

if (sandboxMode) {
  RemovalPolicies.of(blocksStack).destroy();
  Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());
}

// ─── Readings API: custom Lambda behind an IAM-authenticated Function URL ────
// Not built with ApiNamespace: our callers (a Python script on the Pi, an
// external AI agent) aren't a JS frontend, and both need real IAM/SigV4 auth
// enforced by AWS itself — which ApiNamespace's shared-Lambda RPC model can't
// scope per route (auth there is an in-code check per method, not a route-level
// authorizer). See the design spec's "Why a hand-written Lambda" section.
const readingsFn = new NodejsFunction(blocksStack, 'ReadingsHandler', {
  entry: join(__dirname, 'readings.handler.ts'),
  handler: 'handler',
  runtime: lambda.Runtime.NODEJS_22_X,
  bundling: {
    // Without this, DistributedTable (and any other Block import) resolves to
    // its in-memory mock even in the deployed Lambda — this is the exact
    // option @aws-blocks/core's own Lambda bundling uses internally.
    esbuildArgs: { '--conditions': 'aws-runtime' },
  },
  environment: {
    BLOCKS_ENV: isE2E ? 'e2e' : 'prod',
  },
});

const readingsFnUrl = readingsFn.addFunctionUrl({
  authType: lambda.FunctionUrlAuthType.AWS_IAM,
});

new cdk.CfnOutput(blocksStack, 'ReadingsFunctionUrl', { value: readingsFnUrl.url });

// IAM identities only exist for the prod stack — the e2e suite signs with
// whatever ambient AWS credentials already deployed the e2e stack.
if (!isE2E) {
  const piWriter = new iam.User(blocksStack, 'PiWriterUser', { userName: 'fermento-pi-writer' });
  readingsFnUrl.grantInvokeUrl(piWriter);

  const agentReader = new iam.User(blocksStack, 'AgentReaderUser', { userName: 'fermento-agent-reader' });
  readingsFnUrl.grantInvokeUrl(agentReader);
}
```

**Note:** `BlocksStack.create` still provisions its own default Lambda + API Gateway route (`blocksStack.handler`, built from `index.handler.ts`) even though `index.ts` exports no `ApiNamespace`. This is harmless: with no registered API methods or raw routes, every request to it gets a 404 — it exposes no data and needs no cleanup, just don't be surprised to see a second, unrelated Function/API URL in the CDK output.

- [ ] **Step 2: Typecheck**

Run: `cd cloud && npm run typecheck`
Expected: exits 0. (This does not run `cdk synth` — that requires the `--conditions=cdk` guard the framework's own `deploy`/`sandbox` scripts set up; typechecking alone is enough to confirm the CDK code is well-typed at this stage. Full synth/deploy is exercised for real in Task 7.)

- [ ] **Step 3: Commit**

```bash
git add cloud/aws-blocks/index.cdk.ts
git commit -m "$(cat <<'EOF'
Add CDK layer for the readings Lambda, Function URL, and IAM identities

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: E2E environment — deploy, SigV4 test suite, table clearing

**Files:**
- Create: `cloud/e2e/sigv4.ts`, `cloud/e2e/clear-table.ts`, `cloud/e2e/readings.e2e.test.ts`
- Modify: `cloud/package.json` (add `@smithy/signature-v4`, `@smithy/protocol-http`, `@aws-crypto/sha256-js`, `@aws-sdk/credential-provider-node` dependencies; update `test:e2e` script)

**Interfaces:**
- Consumes: nothing from other `cloud/aws-blocks` files (the e2e suite talks over real HTTP to the deployed Function URL, not via direct imports).
- Produces: `signedFetch(method, functionUrl, path, options?)`, `unsignedFetch(method, functionUrl, path, body?)` — reusable by the `run-e2e` skill's own verification if needed later.

- [ ] **Step 1: Install SigV4 signing dependencies**

Run: `cd cloud && npm install @smithy/signature-v4 @smithy/protocol-http @aws-crypto/sha256-js @aws-sdk/credential-provider-node`
Expected: exits 0.

- [ ] **Step 2: Create `cloud/e2e/sigv4.ts`**

```typescript
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

export interface FetchResult {
  status: number;
  body: unknown;
}

export async function signedFetch(
  method: 'GET' | 'POST',
  functionUrl: string,
  path: string,
  options: { body?: unknown; query?: Record<string, string> } = {},
): Promise<FetchResult> {
  const url = new URL(path, functionUrl);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) url.searchParams.set(k, v);
  }

  const region = process.env.AWS_REGION || 'us-east-1';
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region,
    service: 'lambda',
    sha256: Sha256,
  });

  const bodyText = options.body !== undefined ? JSON.stringify(options.body) : undefined;

  const request = new HttpRequest({
    method,
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname + url.search,
    headers: {
      'content-type': 'application/json',
      host: url.hostname,
    },
    body: bodyText,
  });

  const signed = await signer.sign(request);

  const response = await fetch(url.toString(), {
    method,
    headers: signed.headers as Record<string, string>,
    body: bodyText,
  });

  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // leave as raw text
  }
  return { status: response.status, body };
}

export async function unsignedFetch(
  method: 'GET' | 'POST',
  functionUrl: string,
  path: string,
  body?: unknown,
): Promise<{ status: number }> {
  const response = await fetch(new URL(path, functionUrl).toString(), {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status };
}
```

- [ ] **Step 3: Create `cloud/e2e/clear-table.ts`**

This script must run with the `aws-runtime` condition so `readings` resolves to the real DynamoDB client, not the in-memory mock — otherwise it would "clear" an empty local mock and do nothing to the real e2e table. Use `tsx -C aws-runtime`, the same `-C <condition>` form the scaffold's own generated `sandbox:destroy` script already uses (`"tsx -C cdk ..."`) — confirmed working syntax in this tool.

```typescript
import { readings } from '../aws-blocks/index.js';

async function main() {
  const items = [];
  for await (const item of readings.scan()) {
    items.push(item);
  }
  if (items.length === 0) {
    console.log('e2e table already empty');
    return;
  }
  await readings.deleteBatch(items.map((i) => ({ deviceId: i.deviceId, timestamp: i.timestamp })));
  console.log(`cleared ${items.length} item(s) from the e2e table`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 4: Create `cloud/e2e/readings.e2e.test.ts`**

```typescript
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
```

- [ ] **Step 5: Update the `test:e2e` script**

In `cloud/package.json`:
```json
"test:e2e": "tsx --test e2e/readings.e2e.test.ts"
```

- [ ] **Step 6: Deploy the e2e stack for the first time**

Run: `cd cloud && BLOCKS_ENV=e2e npm run deploy`
Expected: CDK deploy succeeds; note the `ReadingsFunctionUrl` value printed in the stack outputs.

- [ ] **Step 7: Clear the e2e table (should be a no-op on a fresh stack) and run the e2e suite**

```bash
cd cloud
npx tsx -C aws-runtime e2e/clear-table.ts
FERMENTO_E2E_FUNCTION_URL="<paste the ReadingsFunctionUrl output>" npm run test:e2e
```
Expected: `clear-table.ts` logs "e2e table already empty" (or clears leftovers from a prior run), and all 3 e2e tests pass.

- [ ] **Step 8: Commit**

```bash
git add cloud/e2e cloud/package.json cloud/package-lock.json
git commit -m "$(cat <<'EOF'
Add e2e test suite and table-clearing script against the isolated e2e stack

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Pi — temperature sensor abstraction

**Files:**
- Create: `pi/sensor.py`
- Test: `pi/tests/test_sensor.py`
- Create: `pi/requirements.txt`, `pi/requirements-dev.txt`

**Interfaces:**
- Produces: `class SensorReadError(Exception)`, `class TemperatureSensor` (interface with `read() -> float`), `class DS18B20Sensor(TemperatureSensor)` (constructor `(device_id: str | None = None, base_path: str = "/sys/bus/w1/devices")`), `class FakeSensor(TemperatureSensor)` (constructor `(value: float | None = None, error: Exception | None = None)`).

- [ ] **Step 1: Create the requirements files**

`pi/requirements.txt`:
```
boto3>=1.34
requests>=2.31
```

`pi/requirements-dev.txt`:
```
-r requirements.txt
pytest>=8.0
```

- [ ] **Step 2: Set up the Python environment**

```bash
cd pi
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
```
Expected: installs succeed.

- [ ] **Step 3: Write the failing tests**

Create `pi/tests/test_sensor.py`:
```python
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
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd pi && python -m pytest tests/test_sensor.py -v`
Expected: FAIL / collection error — `sensor.py` does not exist yet.

- [ ] **Step 5: Create `pi/sensor.py`**

```python
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd pi && python -m pytest tests/test_sensor.py -v`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add pi/sensor.py pi/tests/test_sensor.py pi/requirements.txt pi/requirements-dev.txt
git commit -m "$(cat <<'EOF'
Add DS18B20 temperature sensor reader with fake for tests

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Pi — local retry queue

**Files:**
- Create: `pi/reading_queue.py`
- Test: `pi/tests/test_reading_queue.py`

**Interfaces:**
- Produces: `@dataclass class PendingReading(id: int, timestamp: str, temperature_c: float)`, `class ReadingQueue` with `__init__(db_path: str, max_age_seconds: int = 604800)`, `enqueue(timestamp: str, temperature_c: float) -> None`, `pending() -> list[PendingReading]`, `remove(reading_id: int) -> None`, `close() -> None`.

(Named `reading_queue.py`, not `queue.py`, to avoid shadowing Python's standard library `queue` module.)

- [ ] **Step 1: Write the failing tests**

Create `pi/tests/test_reading_queue.py`:
```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pi && python -m pytest tests/test_reading_queue.py -v`
Expected: FAIL / collection error — `reading_queue.py` does not exist yet.

- [ ] **Step 3: Create `pi/reading_queue.py`**

```python
"""Local durable retry queue for temperature readings, backed by SQLite."""
from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass


@dataclass
class PendingReading:
    id: int
    timestamp: str
    temperature_c: float


class ReadingQueue:
    def __init__(self, db_path: str, max_age_seconds: int = 7 * 24 * 60 * 60):
        self._max_age_seconds = max_age_seconds
        self._conn = sqlite3.connect(db_path)
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS pending_readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                temperature_c REAL NOT NULL,
                enqueued_at REAL NOT NULL
            )
            """
        )
        self._conn.commit()

    def enqueue(self, timestamp: str, temperature_c: float) -> None:
        self._conn.execute(
            "INSERT INTO pending_readings (timestamp, temperature_c, enqueued_at) VALUES (?, ?, ?)",
            (timestamp, temperature_c, time.time()),
        )
        self._conn.commit()
        self._evict_stale()

    def _evict_stale(self) -> None:
        cutoff = time.time() - self._max_age_seconds
        self._conn.execute("DELETE FROM pending_readings WHERE enqueued_at < ?", (cutoff,))
        self._conn.commit()

    def pending(self) -> list[PendingReading]:
        rows = self._conn.execute(
            "SELECT id, timestamp, temperature_c FROM pending_readings ORDER BY id ASC"
        ).fetchall()
        return [PendingReading(id=r[0], timestamp=r[1], temperature_c=r[2]) for r in rows]

    def remove(self, reading_id: int) -> None:
        self._conn.execute("DELETE FROM pending_readings WHERE id = ?", (reading_id,))
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd pi && python -m pytest tests/test_reading_queue.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add pi/reading_queue.py pi/tests/test_reading_queue.py
git commit -m "$(cat <<'EOF'
Add durable SQLite retry queue for pending readings

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Pi — SigV4-signed uploader

**Files:**
- Create: `pi/uploader.py`
- Test: `pi/tests/test_uploader.py`

**Interfaces:**
- Produces: `class UploadError(Exception)`, `upload_reading(function_url: str, region: str, timestamp: str, temperature_c: float) -> None` (raises `UploadError` on failure).

- [ ] **Step 1: Write the failing tests**

Create `pi/tests/test_uploader.py`:
```python
from unittest.mock import MagicMock, patch

import pytest

from uploader import UploadError, upload_reading


@patch("uploader.requests.post")
@patch("uploader.boto3.Session")
def test_upload_reading_sends_a_signed_post(mock_session_cls, mock_post):
    mock_credentials = MagicMock()
    mock_credentials.get_frozen_credentials.return_value = MagicMock(
        access_key="AKIA_TEST", secret_key="secret", token=None
    )
    mock_session_cls.return_value.get_credentials.return_value = mock_credentials
    mock_post.return_value = MagicMock(status_code=201, text="")

    upload_reading(
        "https://example.lambda-url.us-east-1.on.aws/",
        "us-east-1",
        "2026-07-06T12:00:00.000Z",
        21.5,
    )

    assert mock_post.called
    _, kwargs = mock_post.call_args
    assert "Authorization" in kwargs["headers"]


@patch("uploader.requests.post")
@patch("uploader.boto3.Session")
def test_upload_reading_raises_on_non_2xx_response(mock_session_cls, mock_post):
    mock_credentials = MagicMock()
    mock_credentials.get_frozen_credentials.return_value = MagicMock(
        access_key="AKIA_TEST", secret_key="secret", token=None
    )
    mock_session_cls.return_value.get_credentials.return_value = mock_credentials
    mock_post.return_value = MagicMock(status_code=403, text="Forbidden")

    with pytest.raises(UploadError):
        upload_reading(
            "https://example.lambda-url.us-east-1.on.aws/",
            "us-east-1",
            "2026-07-06T12:00:00.000Z",
            21.5,
        )


@patch("uploader.boto3.Session")
def test_upload_reading_raises_when_no_credentials(mock_session_cls):
    mock_session_cls.return_value.get_credentials.return_value = None

    with pytest.raises(UploadError):
        upload_reading(
            "https://example.lambda-url.us-east-1.on.aws/",
            "us-east-1",
            "2026-07-06T12:00:00.000Z",
            21.5,
        )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pi && python -m pytest tests/test_uploader.py -v`
Expected: FAIL / collection error — `uploader.py` does not exist yet.

- [ ] **Step 3: Create `pi/uploader.py`**

```python
"""Signs and uploads a single reading to the cloud ingest endpoint."""
from __future__ import annotations

import json

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


class UploadError(Exception):
    """Raised when the cloud endpoint rejects or fails to receive a reading."""


def upload_reading(function_url: str, region: str, timestamp: str, temperature_c: float) -> None:
    body = json.dumps({"timestamp": timestamp, "temperatureC": temperature_c})

    request = AWSRequest(
        method="POST",
        url=function_url,
        data=body,
        headers={"Content-Type": "application/json"},
    )
    credentials = boto3.Session().get_credentials()
    if credentials is None:
        raise UploadError("No AWS credentials found for the Pi's IAM identity")
    SigV4Auth(credentials.get_frozen_credentials(), "lambda", region).add_auth(request)
    prepared = request.prepare()

    response = requests.post(prepared.url, headers=dict(prepared.headers), data=body, timeout=10)
    if response.status_code >= 300:
        raise UploadError(f"Upload failed with status {response.status_code}: {response.text}")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd pi && python -m pytest tests/test_uploader.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add pi/uploader.py pi/tests/test_uploader.py
git commit -m "$(cat <<'EOF'
Add SigV4-signed uploader for posting readings to the cloud endpoint

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Pi — collector main loop

**Files:**
- Create: `pi/collector.py`
- Test: `pi/tests/test_collector.py`

**Interfaces:**
- Consumes: `TemperatureSensor`, `SensorReadError`, `FakeSensor` (Task 8); `ReadingQueue` (Task 9); `UploadError` (Task 10).
- Produces: `class Collector` with `__init__(sensor, queue, uploader, interval_seconds: int = 120)`, `tick() -> None`, `run_forever() -> None`. `uploader` is any callable `(timestamp: str, temperature_c: float) -> None` that raises `UploadError` on failure.

- [ ] **Step 1: Write the failing tests**

Create `pi/tests/test_collector.py`:
```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pi && python -m pytest tests/test_collector.py -v`
Expected: FAIL / collection error — `collector.py` does not exist yet.

- [ ] **Step 3: Create `pi/collector.py`**

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd pi && python -m pytest tests/test_collector.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full Pi test suite**

Run: `cd pi && python -m pytest -v`
Expected: all tests across all four test files pass (16 tests total).

- [ ] **Step 6: Commit**

```bash
git add pi/collector.py pi/tests/test_collector.py
git commit -m "$(cat <<'EOF'
Add collector main loop tying sensor, queue, and uploader together

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Pi — CLI entrypoint, systemd unit, README

**Files:**
- Create: `pi/main.py`, `pi/.env.example`, `pi/systemd/fermento-collector.service`, `pi/README.md`

**Interfaces:**
- Consumes: `Collector` (Task 11), `ReadingQueue` (Task 9), `DS18B20Sensor` (Task 8), `upload_reading` (Task 10).
- Produces: a runnable `python main.py` entrypoint reading configuration from environment variables.

- [ ] **Step 1: Create `pi/main.py`**

```python
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
```

- [ ] **Step 2: Create `pi/.env.example`**

```
# Copy to .env and fill in with the fermento-pi-writer IAM user's credentials
# and the deployed prod ReadingsFunctionUrl (from `cd cloud && npm run deploy` output).
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
FERMENTO_FUNCTION_URL=
FERMENTO_AWS_REGION=us-east-1
FERMENTO_INTERVAL_SECONDS=120
FERMENTO_QUEUE_DB_PATH=/var/lib/fermento/queue.db
```

- [ ] **Step 3: Create `pi/systemd/fermento-collector.service`**

```ini
[Unit]
Description=FermentoCloud temperature collector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/FermentoCloud/pi
EnvironmentFile=/home/pi/FermentoCloud/pi/.env
ExecStart=/home/pi/FermentoCloud/pi/.venv/bin/python /home/pi/FermentoCloud/pi/main.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: Create `pi/README.md`**

```markdown
# FermentoCloud Pi collector

Reads a DS18B20 temperature probe over 1-Wire and uploads readings to the
FermentoCloud cloud API, buffering locally in SQLite when the network is down.

## One-time hardware setup

1. Wire the DS18B20 data pin to a GPIO pin (with a 4.7kΩ pull-up to 3.3V) per
   the standard DS18B20-on-Pi wiring guide.
2. Enable the 1-Wire kernel driver: add `dtoverlay=w1-gpio` to
   `/boot/firmware/config.txt`, then reboot.
3. Confirm the sensor is visible: `ls /sys/bus/w1/devices/28-*` should list one
   directory.

## One-time software setup

```bash
cd /home/pi/FermentoCloud/pi
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env: fill in AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for the
# fermento-pi-writer IAM user, and FERMENTO_FUNCTION_URL from the cloud deploy output.
sudo mkdir -p /var/lib/fermento && sudo chown pi:pi /var/lib/fermento

sudo cp systemd/fermento-collector.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fermento-collector
```

## Checking it's running

```bash
systemctl status fermento-collector
journalctl -u fermento-collector -f
```

## Deploying a change

Raspberry Pi Connect gives only a browser-based shell (no SSH/rsync/scp), so
there's no automated push. Paste this into the Connect shell, using `main` for
a real deploy or any branch name to try it on hardware before merging:

```bash
cd /home/pi/FermentoCloud && git fetch && git checkout <ref> && git pull && sudo systemctl restart fermento-collector
```
```

- [ ] **Step 5: Manually smoke-test the CLI wiring (no real hardware/network required)**

Run:
```bash
cd pi
source .venv/bin/activate
FERMENTO_FUNCTION_URL=https://example.invalid FERMENTO_QUEUE_DB_PATH=/tmp/fermento-smoke.db python -c "
import main
import sensor
main.DS18B20Sensor = sensor.FakeSensor  # confirm main module wires without crashing
print('main.py imports and wires cleanly')
"
```
Expected: prints `main.py imports and wires cleanly` with no exceptions (this only exercises imports/wiring, not the real blocking `run_forever()` loop).

- [ ] **Step 6: Commit**

```bash
git add pi/main.py pi/.env.example pi/systemd pi/README.md
git commit -m "$(cat <<'EOF'
Add Pi CLI entrypoint, systemd unit, and setup README

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Skill — `deploy`

**Files:**
- Create: `.claude/skills/deploy/SKILL.md`

**Interfaces:**
- Consumes: `cloud/`'s `npm run deploy` script (Task 1/6); the git-checkout-and-restart command documented in `pi/README.md` (Task 12).

- [ ] **Step 1: Create the skill directory and file**

Create `.claude/skills/deploy/SKILL.md`:
```markdown
---
name: deploy
description: Deploy the FermentoCloud cloud stack to production and print the Pi update command. Use when the user asks to deploy or ship FermentoCloud changes.
---

# Deploy FermentoCloud

1. Deploy the cloud stack to production:
   ```bash
   cd cloud && npm run deploy
   ```
   Report the `ReadingsFunctionUrl` output value to the user if it changed.

2. Ask the user which git ref they want running on the Pi (default: `main`).

3. Print this exact command for the user to paste into the Raspberry Pi
   Connect browser shell — do not attempt to run it yourself, Claude has no
   tool access to drive Raspberry Pi Connect's browser UI:
   ```bash
   cd /home/pi/FermentoCloud && git fetch && git checkout <ref> && git pull && sudo systemctl restart fermento-collector
   ```
   Substitute `<ref>` with the branch or `main` the user chose.

4. Remind the user this same command works to try a branch on real hardware
   before merging — `<ref>` isn't limited to `main`.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/deploy
git commit -m "$(cat <<'EOF'
Add deploy skill for shipping cloud + Pi changes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Skill — `run-e2e`

**Files:**
- Create: `.claude/skills/run-e2e/SKILL.md`

**Interfaces:**
- Consumes: `cloud/e2e/clear-table.ts`, `cloud/e2e/readings.e2e.test.ts` (Task 7).

- [ ] **Step 1: Create the skill directory and file**

Create `.claude/skills/run-e2e/SKILL.md`:
```markdown
---
name: run-e2e
description: Deploy/update the isolated FermentoCloud e2e stack, clear its table, and run the e2e test suite. Use when the user asks to run e2e tests for FermentoCloud.
---

# Run FermentoCloud e2e tests

1. Deploy or update the e2e stack:
   ```bash
   cd cloud && BLOCKS_ENV=e2e npm run deploy
   ```
   Capture the `ReadingsFunctionUrl` output value.

2. Clear any leftover data from a previous run:
   ```bash
   cd cloud && npx tsx -C aws-runtime e2e/clear-table.ts
   ```

3. Run the e2e suite against that Function URL:
   ```bash
   cd cloud && FERMENTO_E2E_FUNCTION_URL="<url from step 1>" npm run test:e2e
   ```

4. Report pass/fail. On failure, include the failing test names and assertion
   output — don't just say "e2e failed."

The e2e stack is left deployed between runs (this skill only clears table
data, it never tears the stack down) — this trades a small ongoing DynamoDB
cost for faster iteration, as decided in the design spec.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/run-e2e
git commit -m "$(cat <<'EOF'
Add run-e2e skill for the isolated e2e environment

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Skill — `read-fermento-api`

**Files:**
- Create: `.claude/skills/read-fermento-api/SKILL.md`

**Interfaces:**
- Consumes: the prod `GET /readings` API shape (Task 4/5/6). This skill is meant to be copied into the external AI agent's own project — it documents an API contract, not this repo's internals.

- [ ] **Step 1: Create the skill directory and file**

Create `.claude/skills/read-fermento-api/SKILL.md`:
```markdown
---
name: read-fermento-api
description: How to call the FermentoCloud GET /readings API to fetch recent bioreactor temperature readings. Use when asked to check, poll, or fetch FermentoCloud temperature data.
---

# Reading FermentoCloud temperature data

FermentoCloud exposes one read endpoint: `GET /readings` on an AWS Lambda
Function URL, authenticated with IAM (SigV4) — not an API key or bearer token.
You need AWS credentials for the `fermento-agent-reader` IAM identity
(access key + secret, or another AWS credential source that resolves to that
identity) with permission to invoke this specific Function URL.

**Endpoint:** the Function URL is deployment-specific — get it from whoever
runs FermentoCloud's `deploy` skill/CDK stack (`ReadingsFunctionUrl` stack
output). Treat it as configuration, not something to hardcode.

**Request:** `GET <function-url>/readings?since=<ISO8601>&limit=<N>`
- `since` (optional): ISO 8601 timestamp; only readings strictly after this are
  returned. Defaults to 24 hours ago if omitted or invalid.
- `limit` (optional): max items to return, 1-1000. Defaults to 100 if omitted
  or invalid.

**Response:** `200 OK` with JSON body `{ "readings": [ { "deviceId": string,
"timestamp": string, "metric": "temperature", "value": number } ] }`.
`value` is always Celsius. Readings are ordered ascending by `timestamp`.

**Example (Python, using botocore for SigV4 signing):**
```python
import json
import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

function_url = "<the deployed ReadingsFunctionUrl>"
region = "us-east-1"

request = AWSRequest(method="GET", url=f"{function_url}readings?limit=20")
credentials = boto3.Session().get_credentials().get_frozen_credentials()
SigV4Auth(credentials, "lambda", region).add_auth(request)
prepared = request.prepare()

response = requests.get(prepared.url, headers=dict(prepared.headers), timeout=10)
readings = response.json()["readings"]
```

An unsigned or wrongly-signed request gets `403`. A malformed/out-of-range
`since`/`limit` is silently clamped to the defaults above, never a 400 — this
endpoint favors returning something reasonable over failing a poll.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/read-fermento-api
git commit -m "$(cat <<'EOF'
Add read-fermento-api skill documenting the agent-facing read API

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Manual end-to-end hardware verification

Not automatable — requires the physical Pi, sensor, and a real prod deployment. This is the final confirmation that the whole pipeline genuinely works, matching the original goal ("see how it works end to end only with temperature").

**Steps (run these yourself, report results — do not claim success without doing them):**

- [ ] **Step 1:** Deploy prod: `cd cloud && npm run deploy`. Confirm it succeeds and note the `ReadingsFunctionUrl`.
- [ ] **Step 2:** Create the `fermento-pi-writer` IAM user's access key (via AWS Console or `aws iam create-access-key --user-name fermento-pi-writer`) and put it in the Pi's `.env` per `pi/README.md`.
- [ ] **Step 3:** Follow `pi/README.md`'s hardware + software setup on the real Pi, with the real DS18B20 wired in.
- [ ] **Step 4:** Start the systemd service, then run `journalctl -u fermento-collector -f` and confirm readings are logged without errors for at least 2-3 collector ticks.
- [ ] **Step 5:** From any machine with the `fermento-agent-reader` credentials, call `GET /readings` (using the example in `.claude/skills/read-fermento-api/SKILL.md`) and confirm the readings uploaded from the real Pi appear with plausible temperature values.
- [ ] **Step 6:** Briefly disconnect the Pi's network (or block the Function URL host), confirm readings keep accumulating in the local SQLite queue (check `sqlite3 /var/lib/fermento/queue.db "select count(*) from pending_readings;"`), then reconnect and confirm the queue drains on the next tick.

Report the outcome of each step plainly (pass/fail with what you observed) rather than a general "it works."
