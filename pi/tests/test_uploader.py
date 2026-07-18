from unittest.mock import MagicMock, patch

import pytest

from uploader import UploadError, upload_reading


@patch("uploader.requests.post")
@patch("uploader.boto3.Session")
def test_upload_reading_sends_a_signed_post(mock_session_cls, mock_post):
    mock_credentials = MagicMock()
    mock_credentials.get_frozen_credentials.return_value = MagicMock(
        access_key="AKIA_TEST", secret_key="secret", token=None
    )
    mock_session_cls.return_value.get_credentials.return_value = mock_credentials
    mock_post.return_value = MagicMock(status_code=201, text="")

    upload_reading(
        "https://example.lambda-url.us-east-1.on.aws/",
        "us-east-1",
        "2026-07-06T12:00:00.000Z",
        21.5,
    )

    assert mock_post.called
    args, kwargs = mock_post.call_args
    assert "Authorization" in kwargs["headers"]
    # Must target the /readings route, not the bare Function URL root.
    posted_url = args[0] if args else kwargs.get("url")
    assert posted_url == "https://example.lambda-url.us-east-1.on.aws/readings"


@patch("uploader.requests.post")
@patch("uploader.boto3.Session")
def test_upload_reading_raises_on_non_2xx_response(mock_session_cls, mock_post):
    mock_credentials = MagicMock()
    mock_credentials.get_frozen_credentials.return_value = MagicMock(
        access_key="AKIA_TEST", secret_key="secret", token=None
    )
    mock_session_cls.return_value.get_credentials.return_value = mock_credentials
    mock_post.return_value = MagicMock(status_code=403, text="Forbidden")

    with pytest.raises(UploadError):
        upload_reading(
            "https://example.lambda-url.us-east-1.on.aws/",
            "us-east-1",
            "2026-07-06T12:00:00.000Z",
            21.5,
        )


@patch("uploader.boto3.Session")
def test_upload_reading_raises_when_no_credentials(mock_session_cls):
    mock_session_cls.return_value.get_credentials.return_value = None

    with pytest.raises(UploadError):
        upload_reading(
            "https://example.lambda-url.us-east-1.on.aws/",
            "us-east-1",
            "2026-07-06T12:00:00.000Z",
            21.5,
        )
