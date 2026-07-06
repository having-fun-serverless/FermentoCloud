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
