import { Router, BadRequestError } from '@aws-lambda-powertools/event-handler/http';
import type { HandlerResponse } from '@aws-lambda-powertools/event-handler/types';
import type { Context } from 'aws-lambda';
import type { HandlerResult } from './readings.js';
import { putReading, listReadingsSince, ValidationError } from './readings.js';
import { readings, DEVICE_ID, logger } from './index.js';

const app = new Router();

// `HandlerResult.body` is typed `unknown` in readings.ts's pure business-logic
// layer (it doesn't know about Powertools' JSON-serializable response types).
// At this composition-root boundary we know the values are always plain,
// JSON-serializable data, so we assert the shape rather than widen either
// side's types.
function toHandlerResponse(result: HandlerResult): HandlerResponse {
  return result as unknown as HandlerResponse;
}

app.post('/readings', async ({ req }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new BadRequestError('Body must be valid JSON');
  }
  try {
    return toHandlerResponse(await putReading(readings, DEVICE_ID, body));
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new BadRequestError(error.message);
    }
    throw error; // not a validation problem — let it become a 500, don't mask it as a 400
  }
});

app.get('/readings', async ({ req }) => {
  const url = new URL(req.url);
  return toHandlerResponse(await listReadingsSince(readings, DEVICE_ID, url.searchParams));
});

export const handler = async (event: unknown, context: Context) => {
  try {
    return await app.resolve(event, context);
  } catch (error) {
    logger.error('Unhandled error in readings handler', { error: String(error) });
    throw error;
  }
};
