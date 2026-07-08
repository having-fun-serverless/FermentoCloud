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
output). Treat it as configuration, not something to hardcode. Lambda Function
URLs always end in a trailing `/`, so append `readings` directly with no
extra slash (e.g. `f"{function_url}readings"`, not `f"{function_url}/readings"`).

**Request:** `GET <function-url>readings?since=<ISO8601>&limit=<N>`
- `since` (optional): ISO 8601 timestamp; only readings strictly after this are
  returned. Defaults to 24 hours ago if omitted or invalid.
- `limit` (optional): max items to return, 1-1000. Defaults to 100 if omitted
  or invalid.

**Response:** `200 OK` with JSON body `{ "readings": [ { "deviceId": string,
"timestamp": string, "metric": "temperature", "value": number } ] }`.
`value` is always Celsius. Readings are ordered ascending by `timestamp`.

**Example (Python, using botocore for SigV4 signing):**
```python
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
