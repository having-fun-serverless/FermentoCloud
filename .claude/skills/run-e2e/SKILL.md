---
name: run-e2e
description: Deploy/update the isolated FermentoCloud e2e stack, clear its table, and run the e2e test suite. Use when the user asks to run e2e tests for FermentoCloud.
---

# Run FermentoCloud e2e tests

1. Deploy or update the e2e stack:
   ```bash
   cd cloud && BLOCKS_ENV=e2e npm run deploy
   ```
   Capture the `ReadingsFunctionUrl` output value. Also note the deployed
   stack name — CDK prints it repeatedly throughout the deploy output (e.g.
   `cloud-97e092-e2e: deploying...`, `✅  cloud-97e092-e2e`), before the
   `Outputs:` section. You'll need it in step 2.

2. Clear any leftover data from a previous run. This requires
   `BLOCKS_STACK_NAME` set to the exact stack name captured in step 1 (without
   it, `DistributedTable` cannot resolve the correct physical table name and
   the script throws) and `BLOCKS_ENV=e2e` set (without it, the scope-name
   logic defaults to the prod scope and the script resolves the wrong table).
   Invoke `tsx` directly rather than via `npx`, since `npx tsx -C ...` causes
   `npx` to intercept the `-C` flag before tsx sees it:
   ```bash
   cd cloud && BLOCKS_STACK_NAME="<stack name from step 1>" BLOCKS_ENV=e2e ./node_modules/.bin/tsx -C aws-runtime e2e/clear-table.ts
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
