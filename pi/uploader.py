"""Signs and uploads a single reading to the cloud ingest endpoint."""
from __future__ import annotations

import json

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


class UploadError(Exception):
    """Raised when the cloud endpoint rejects or fails to receive a reading."""


def upload_reading(function_url: str, region: str, timestamp: str, temperature_c: float) -> None:
    body = json.dumps({"timestamp": timestamp, "temperatureC": temperature_c})

    request = AWSRequest(
        method="POST",
        url=function_url,
        data=body,
        headers={"Content-Type": "application/json"},
    )
    credentials = boto3.Session().get_credentials()
    if credentials is None:
        raise UploadError("No AWS credentials found for the Pi's IAM identity")
    SigV4Auth(credentials.get_frozen_credentials(), "lambda", region).add_auth(request)
    prepared = request.prepare()

    response = requests.post(prepared.url, headers=dict(prepared.headers), data=body, timeout=10)
    if response.status_code >= 300:
        raise UploadError(f"Upload failed with status {response.status_code}: {response.text}")
