import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Table } from 'aws-cdk-lib/aws-dynamodb';

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
    // Required at runtime by DistributedTable (and other Blocks resources) to
    // derive physical resource names (e.g. DynamoDB table names). Without this,
    // Scope's constructor falls back to no stack prefix at all, and table
    // lookups resolve to the wrong (non-existent) name. See
    // @aws-blocks/core/src/common/index.ts and blocks-backend.ts for the
    // equivalent handling in the framework's own Handler Lambda.
    BLOCKS_STACK_NAME: blocksStack.stackName,
  },
});

// DistributedTable's own grantReadWriteData(this.handler) only covers the
// framework's shared Handler Lambda (resolved by walking up the construct
// tree), never this hand-rolled readingsFn — which by design bypasses that
// shared Handler (see the "Why a hand-written Lambda" note above). So we
// import the already-provisioned readings table by its known physical name
// (same DistributedTable/Scope naming formula used elsewhere in this repo)
// and grant readingsFn access to it directly.
const readingsTableName = `${stackName}-${isE2E ? 'fermento-e2e' : 'fermento-cloud'}-readings`;
const readingsTable = Table.fromTableName(blocksStack, 'ReadingsTableRef', readingsTableName);
readingsTable.grantReadWriteData(readingsFn);

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
