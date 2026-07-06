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
