import type { DistributedTable } from '@aws-blocks/blocks';
import type { Reading, readings } from './index.js';

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
  table: Pick<typeof readings, 'query'>,
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
