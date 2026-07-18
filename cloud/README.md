# FermentoCloud — cloud backend

The AWS side of FermentoCloud: stores bioreactor temperature readings and
serves them back over an IAM-authenticated read API. Built with CDK + AWS
Blocks. See the [project README](../README.md) for the full pipeline.

## What's here

The ingest and read endpoints are a hand-written Lambda behind an
**IAM-authenticated Function URL** (SigV4), not an ApiNamespace RPC — because
the callers are a Python collector on the Pi and external agents, which need
real per-identity IAM auth rather than a JS-frontend RPC client.

- **`POST /readings`** — ingest a reading; the Pi collector calls this.
- **`GET /readings?since=&limit=`** — read recent readings, ordered ascending
  by timestamp.
- Readings persist in a **DynamoDB** `DistributedTable`, keyed by
  `deviceId` (partition) + `timestamp` (sort), validated with a Zod schema.
- Two scoped IAM users are created on non-e2e deploys:
  `fermento-pi-writer` (invoke ingest) and `fermento-agent-reader` (invoke read).

## Project structure

| Path | Purpose |
|------|---------|
| `aws-blocks/index.ts` | Data model: `Scope`, DynamoDB `readings` table, Zod schema. |
| `aws-blocks/index.cdk.ts` | Infra: readings Lambda, Function URL, IAM users/grants. |
| `aws-blocks/readings.handler.ts` | Lambda handler routing `GET`/`POST /readings`. |
| `aws-blocks/readings.ts` | Reading read/write logic against the table. |
| `e2e/readings.e2e.test.ts` | End-to-end tests against a deployed Function URL. |
| `e2e/sigv4.ts` | SigV4 signing helper for the e2e client. |
| `e2e/clear-table.ts` | Clears the e2e table between runs. |

## Commands

| Command | Description |
|---------|-------------|
| `npm run deploy` | Deploy the production stack. |
| `BLOCKS_ENV=e2e npm run deploy` | Deploy the e2e stack. |
| `npm test` | Run unit tests (`aws-blocks/**/*.test.ts`). |
| `npm run test:e2e` | Run e2e tests against a deployed Function URL. |
| `npm run typecheck` | TypeScript type checking. |
| `npm run sandbox` | Deploy a personal sandbox stack. |
| `npm run destroy` / `sandbox:destroy` | Tear down the prod / sandbox stack. |

`npm run deploy` prints the `ReadingsFunctionUrl` output — that URL plus an
access key for the relevant IAM user is what clients need. Deploying and
running e2e are also wrapped by the [`deploy`](../.claude/skills/deploy) and
[`run-e2e`](../.claude/skills/run-e2e) skills.

## Requires

Node >= 22 and AWS credentials with permission to deploy the stack.
