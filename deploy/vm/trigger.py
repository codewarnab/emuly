#!/usr/bin/python3
"""Outbound-only trigger. Never log credentials, addresses, responses or exceptions."""
import http.client
import os
from pathlib import Path
import re
import ssl
import sys
from urllib.parse import urlsplit


def trigger():
    credentials = Path(os.environ["CREDENTIALS_DIRECTORY"])
    endpoint = credentials.joinpath("endpoint").read_text().strip()
    secret = credentials.joinpath("secret").read_text().strip()
    url = urlsplit(endpoint)
    # Pin one HTTPS endpoint. No redirects, proxy environment, arbitrary paths or ports.
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.port not in (None, 443) or url.path != "/api/cron"
            or url.query or url.fragment
            or not re.fullmatch(r"[A-Za-z0-9.-]+", url.hostname)
            or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", secret)):
        raise ValueError("Invalid configuration")
    connection = http.client.HTTPSConnection(url.hostname, timeout=290,
                                            context=ssl.create_default_context())
    try:
        connection.request("GET", "/api/cron", headers={
            "Authorization": "Bearer " + secret,
            "User-Agent": "Emuly-Scheduler/1",
        })
        status = connection.getresponse().status
        # Do not read or execute the response body. Redirects fail closed.
        if status in (200, 409):
            print("Scheduler completed" if status == 200 else "Scheduler already running")
            return 0
        print("Scheduler rejected request", file=sys.stderr)
        return 1
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        sys.exit(trigger())
    except Exception:
        print("Scheduler failed; check private configuration or connectivity", file=sys.stderr)
        sys.exit(1)
