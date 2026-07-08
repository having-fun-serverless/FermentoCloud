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

  // SignatureV4's canonical query string is derived from HttpRequest#query,
  // NOT by re-parsing `path` — so query params must be passed separately here
  // as well as embedded in `path`, or the signature covers an empty query
  // string while the real request (sent via `path + search` below) doesn't,
  // causing AWS to reject every signed request that has query params with a
  // generic "signature we calculated does not match" 403.
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) query[k] = v;

  const request = new HttpRequest({
    method,
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    query,
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
