# FermentoCloud: Temperature Monitoring Pipeline (Phase 1) — Design

## Purpose

FermentoCloud is an educational bioreactor project: a Raspberry Pi collects sensor
data from a yeast fermentation vessel and uploads it to the cloud, where a separate,
external AI agent (built and owned outside this repo) polls the data and notifies
the owner via Telegram. The project doubles as the basis for a blog post explaining
the science and technology behind the bioreactor.

This design covers **Phase 1 only**: temperature monitoring end-to-end. A pH sensor
is planned for Phase 2; the data model leaves room for it but no pH-specific code is
built now.

## Goals

- Read temperature from a DS18B20 sensor on the Pi and get it into the cloud
  reliably, tolerating network blips.
- Store readings so they can be queried by time range.
- Expose a query endpoint that an external AI agent can call to pull recent
  readings, authenticated via IAM — independent of this repo.
- Keep cloud costs near zero at this data volume (one reading every few minutes,
  single device).
- Keep the whole thing testable without physical hardware or a deployed AWS stack,
  plus a true end-to-end test against a real (but isolated) AWS deployment.

## Non-goals (this phase)

- pH sensing (Phase 2).
- Any live/streaming dashboard (a natural Phase 3 if pursued; not built now).
- The AI agent's monitoring/notification logic itself — out of scope, owned
  elsewhere. This repo only needs to expose a stable, authenticated read API for it.
- Multi-device support beyond a single bioreactor.

## Architecture

```
┌───────────────────────┐  SigV4-signed POST /readings   ┌────────────────────────────┐
│ Raspberry Pi          │ ──────────────────────────────>│ Lambda Function URL       │
│ pi/collector.py       │  (Pi IAM identity, invoke-only)│ (AuthType: AWS_IAM)       │
│  - reads DS18B20      │                                │ Powertools Router:        │
│  - local SQLite       │                                │  POST /readings           │
│    retry queue        │                                │  GET  /readings           │
│  - runs as a          │                                │ → DistributedTable block  │
│    systemd service    │                                │   (DynamoDB)              │
└───────────────────────┘                                └────────────────────────────┘
                                                                        ▲
┌───────────────────────┐  SigV4-signed GET /readings                  │
│ External AI agent     │ ──────────────────────────────────────────────┘
│ (out of scope)        │  (agent IAM identity, invoke-only)
└───────────────────────┘

CDK layer (cloud/aws-blocks/index.cdk.ts) defines the Lambda, Function URL, and IAM policies.
Scope name ('fermento-cloud' vs 'fermento-e2e') is chosen by BLOCKS_ENV for environment isolation.
```

Two independent codebases in one repo, interacting only over the HTTP API:

- `pi/` — Python collector script, runs continuously on the Raspberry Pi as a
  systemd service. No AWS SDK dependency beyond SigV4 request signing.
- `cloud/` — AWS Blocks (TypeScript, CDK-based) app providing the ingest/query API
  and storage.

### Why a hand-written Lambda instead of `ApiNamespace`

AWS Blocks' default `ApiNamespace` mechanism is a typed RPC bridge for a JS/TS
frontend: methods are invoked by name over JSON-RPC 2.0, and all methods in a
namespace share one Lambda ("lambda-lith") behind one API Gateway route, with
authorization checked in application code per method rather than configured
per-route. Since neither of our callers (a Python script, an external agent) is a
JS frontend, and both need real IAM/SigV4 auth enforced by AWS itself (not just
application code), we instead define our own Lambda directly in the CDK layer
(`aws-blocks/index.cdk.ts`), behind a Lambda **Function URL** with
`AuthType: AWS_IAM`. Inside it, [AWS Lambda Powertools' HTTP event
handler](https://docs.aws.amazon.com/powertools/typescript/latest/features/event-handler/http/)
provides `app.post('/readings', ...)` and `app.get('/readings', ...)` routing
(Powertools explicitly supports Function URLs as an event source, auto-detecting
the event type). Block instances (like `DistributedTable`) can still be imported
and used from this hand-written Lambda — they resolve based on execution context
regardless of which file imports them.

## Data storage

Uses the `DistributedTable` Block (provisions plain on-demand **DynamoDB**, not
`Database`/`DistributedDatabase` which provision Aurora — Aurora Serverless v2
bills a minimum ACU continuously even at rest, which doesn't fit the "near-zero
cost" goal at this data volume). `DistributedTable` also fits the access pattern:
range queries by sort key, which the flat `KVStore` explicitly does not support.

- Partition key: `deviceId` (constant, e.g. `"fermenter-1"` — one device for now,
  but a real key rather than a hardcoded singleton row).
- Sort key: `timestamp` (ISO 8601 string — sorts correctly as text, human-readable
  in the console for blog screenshots).
- Item shape: `{ deviceId, timestamp, metric: "temperature", value: number }`.
  Unit is not stored — temperature is always recorded in the same unit (Celsius),
  fixed by convention in the Pi collector and any readers. The `metric` field is
  what lets Phase 2 add `metric: "ph"` items to the same table with no schema
  change.

## API

Both routes live behind one IAM-authenticated Lambda Function URL.

- `POST /readings` — body `{ timestamp: string (ISO 8601), temperatureC: number }`.
  `deviceId` is not sent by the Pi; it's a fixed constant in the Lambda's config.
  Writes one item to `DistributedTable`. Malformed bodies (missing/invalid
  `timestamp` or `temperatureC`) get a 400. No app-level auth check needed beyond
  the Function URL's IAM auth having already accepted the SigV4 signature.
- `GET /readings?since=<ISO8601>&limit=<N>` — queries for `deviceId = <constant>`
  and `timestamp > since`, ascending, capped by `limit`. Defaults: `since` = 24h
  ago, `limit` = 100. Invalid params are clamped to defaults rather than erroring
  (this is a read path for a polling agent — better to return something reasonable
  than fail the poll).

Unexpected exceptions in either route are caught by Powertools and logged via the
`Logger` Block, returned as a clean 500.

## IAM identities

Two IAM identities, each an IAM user with a long-lived access key, scoped via
policy to `lambda:InvokeFunctionUrl` on exactly one function ARN:

| Identity | Scoped to | Used by |
|---|---|---|
| `fermento-pi-writer` | prod Function URL | Pi's `collector.py`, signs POSTs |
| `fermento-agent-reader` | prod Function URL | External AI agent, signs GETs (built/owned outside this repo) |

The e2e suite does not get its own dedicated IAM identity. Whoever runs the
`run-e2e` skill already has AWS credentials capable of deploying the e2e CDK
stack, and deploy permissions are a superset of invoke permissions in any
realistic setup — so the e2e suite signs its test requests with those same
ambient credentials. The e2e assertions ("a signed request succeeds," "an
unsigned request gets 403," "a malformed body gets 400") don't require a
specifically-scoped identity, just the presence or absence of a valid signature.

No in-code check restricts which routes an authenticated identity may call
(e.g. the Pi's identity could technically call GET too) — any successfully
SigV4-authenticated principal may call either route. This is an accepted
simplification for this project's scope; a future hardening pass could check
`event.requestContext.authorizer.iam.userArn` in code if ever needed.

A long-lived IAM user + access key (rather than IAM Roles Anywhere) was chosen for
the Pi's credential: simpler to set up, matches this project's current complexity
budget. Static credentials on the Pi's SD card are an accepted tradeoff for an
educational, single-device project.

## Pi collector internals

- `sensor.py` — a `TemperatureSensor` interface with one real implementation,
  `DS18B20Sensor.read() -> float`, reading `/sys/bus/w1/devices/<id>/w1_slave`,
  checking the CRC ("YES") line, parsing the `t=` value, converting to Celsius.
  Raises on a bad/missing reading rather than returning a garbage value. A
  `FakeSensor` (returns a preset/queued value) exists for tests, so no hardware is
  needed to develop or test the collector logic.
- `queue.py` — a local SQLite table `pending_readings(id, timestamp,
  temperature_c)` acting as a durable retry buffer, capped so a prolonged outage
  can't fill the SD card (oldest entries dropped beyond a bound, e.g. a few days).
- `collector.py` — main loop, on a configurable interval (default 2 min):
  1. Read the sensor; on failure, log and skip this tick (never enqueue a bad
     value).
  2. On success, insert the reading into the local queue.
  3. Flush the queue oldest-first: SigV4-sign and POST each pending row; on
     success, delete that row; on first failure, stop flushing and retry from the
     same point next tick (preserves order, avoids hammering a downed endpoint).
- Runs as a `systemd` service (`pi/systemd/fermento-collector.service`,
  `Restart=on-failure`, `WantedBy=multi-user.target`) so it starts on boot without
  a login session and restarts if the process dies. On restart, the durable SQLite
  queue means no in-flight readings are lost.

## Testing

- **Pi**: pytest unit tests — `DS18B20Sensor` parsing (canned `w1_slave` contents,
  including the CRC-fail case), the SQLite queue (insert/flush/failure-leaves-row),
  and the collector loop using `FakeSensor` + a stubbed HTTP client. No hardware or
  AWS needed.
- **Cloud (local)**: the route logic is written as plain functions (parsed
  request in, response out), separate from the Lambda entry point that wraps
  them with Powertools' router. Local tests import and call those functions
  directly in-process — no HTTP server involved. Because the test runs in a
  plain Node process, the `DistributedTable` import resolves to its local
  in-memory implementation, so this needs no AWS account. (This sidesteps an
  open question: a hand-written CDK-layer Lambda behind a Function URL is a
  real AWS construct with no documented `npm run dev` equivalent, unlike
  `ApiNamespace` methods — direct function invocation avoids depending on
  that.)
- **Cloud (e2e, real AWS)**: a separate, isolated deployment (see below) exercised
  by a real test suite: clear the e2e table, POST a known reading, GET it back and
  assert the round-trip, confirm a malformed POST gets 400, confirm an unsigned
  request gets 403.
- Not automated: the actual DS18B20 hardware read and a real IAM-signed call from
  the physical Pi over the internet — verified manually once deployed, matching
  the original "see it work end-to-end" goal.

## Pi deployment

Raspberry Pi Connect (the remote access tool in use) provides only a
browser-based interactive shell — no `scp`/`rsync`/SSH `ProxyCommand` support,
and sessions don't persist state. So there's no automated push path onto the Pi.
Instead, `pi/` is deployed by running one command by hand, pasted into the
Connect browser shell:

```
git fetch && git checkout <ref> && git pull && sudo systemctl restart fermento-collector
```

`<ref>` is any branch or `main` — the same single mechanism covers both trying a
branch on real hardware before merging and deploying `main` for real. No
systemd auto-pull timer, since that would only cover `main` and wouldn't help
test unmerged branches. The `deploy` skill's job re: the Pi is to print this
exact command for a given ref for you to paste — Claude has no tool access to
drive Raspberry Pi Connect's browser UI itself.

## E2E environment

`cloud/aws-blocks/index.ts` reads `process.env.BLOCKS_ENV` to choose the `Scope`
name: `fermento-cloud` (prod, default) or `fermento-e2e`. Deploying with
`BLOCKS_ENV=e2e npm run deploy` stands up a fully separate stack — its own
DynamoDB table, Lambda, and Function URL — via the normal CDK deploy path, rather
than relying on Blocks' built-in `npm run sandbox` (whose per-developer identity
semantics aren't a confirmed fit for repeated, automated runs). The e2e stack is
left deployed between runs; each run clears its table first rather than tearing
down and redeploying, trading a small ongoing DynamoDB cost (expected to stay in
the free tier at this volume) for faster iteration.

## Operational tooling: skills

Three Claude Code skills, built with the skill-creator conventions:

1. **`run-e2e`** — deploys/updates the `fermento-e2e` stack, clears its table,
   runs the e2e test suite, reports pass/fail.
2. **`deploy`** — deploys the cloud app to the prod (`fermento-cloud`) Scope, and
   prints the git-checkout-and-restart command (see "Pi deployment" above) for
   you to paste into the Raspberry Pi Connect shell.
3. **`read-fermento-api`** — a portable skill, meant to be copied into the
   external AI agent's own project, documenting the prod `GET /readings`
   endpoint: URL, the SigV4/IAM auth requirement, query params, response shape,
   and a runnable example request.

## Future phases (not built now)

- Phase 2: pH sensor — new `metric: "ph"` items in the same table, a second
  `TemperatureSensor`-like interface on the Pi for the pH probe.
- Phase 3 (possible): a `Realtime` pub/sub Block for live-updating readings, if a
  live dashboard becomes useful for the blog content.
