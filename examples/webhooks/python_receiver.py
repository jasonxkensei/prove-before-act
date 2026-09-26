"""Minimal Python 3.11+ proof.certified receiver (standard library only).

Run: PBA_WEBHOOK_DB=webhooks.sqlite python3 examples/webhooks/python_receiver.py
Before a callback arrives, store the per-proof webhook_secret returned by the API:
  sqlite3 webhooks.sqlite "INSERT INTO proof_secrets VALUES ('<proof_id>', '<webhook_secret>');"
Expose /webhooks/prove-before-act over HTTPS with your own reverse proxy.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Literal, TypedDict


class Blockchain(TypedDict):
    network: str
    transaction_hash: str | None
    explorer_url: str | None


class ProofCertifiedPayload(TypedDict):
    event: Literal["proof.certified"]
    proof_id: str
    status: Literal["certified"]
    file_hash: str
    filename: str
    verify_url: str
    certificate_url: str
    proof_json_url: str
    blockchain: Blockchain
    timestamp: str  # Creation time; NOT the Unix-seconds signature header.


def verify(raw_body: bytes, signature: str, timestamp: str, secret: str,
           now: int | None = None) -> bool:
    if not re.fullmatch(r"[0-9]+", timestamp) or not re.fullmatch(r"[0-9a-f]{64}", signature):
        return False
    current = int(time.time()) if now is None else now
    if not current - 300 <= int(timestamp) <= current + 60:
        return False
    expected = hmac.new(secret.encode("utf-8"), timestamp.encode("ascii") + b"." + raw_body,
                        hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def init_db(path: str) -> None:
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE IF NOT EXISTS proof_secrets "
                   "(proof_id TEXT PRIMARY KEY, secret TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS deliveries "
                   "(delivery_id TEXT PRIMARY KEY, payload TEXT NOT NULL)")


class Receiver(BaseHTTPRequestHandler):
    db_path = "webhooks.sqlite"

    def do_POST(self) -> None:
        if self.path != "/webhooks/prove-before-act":
            self.send_error(404)
            return
        signature = self.headers.get("X-ProveBeforeAct-Signature", "")
        timestamp = self.headers.get("X-ProveBeforeAct-Timestamp", "")
        event = self.headers.get("X-ProveBeforeAct-Event", "")
        delivery = self.headers.get("X-ProveBeforeAct-Delivery", "")
        if not delivery or event != "proof.certified":
            self.send_error(400)
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
            if length < 0 or length > 1024 * 1024:
                raise ValueError("invalid length")
            raw_body = self.rfile.read(length)  # Read before JSON parsing; never reserialize for HMAC.
            with sqlite3.connect(self.db_path) as db:
                row = db.execute("SELECT secret FROM proof_secrets WHERE proof_id = ?",
                                 (delivery,)).fetchone()
                if not row or not verify(raw_body, signature, timestamp, row[0]):
                    self.send_error(401)
                    return
                payload: ProofCertifiedPayload = json.loads(raw_body)
                if not isinstance(payload, dict):
                    self.send_error(400)
                    return
                if payload["proof_id"] != delivery or payload["event"] != event or payload["status"] != "certified":
                    self.send_error(400)
                    return
                # Commit the application action and delivery ID together. Replace this
                # INSERT with your own transactional, idempotent business logic.
                db.execute("INSERT OR IGNORE INTO deliveries (delivery_id, payload) VALUES (?, ?)",
                           (delivery, raw_body.decode("utf-8")))
            self.send_response(200)  # Acknowledge duplicates without processing twice.
            self.end_headers()
        except (ValueError, KeyError, UnicodeDecodeError):
            self.send_error(400)
        except sqlite3.Error:
            self.send_error(500)  # Retry when storage fails.


if __name__ == "__main__":
    Receiver.db_path = os.environ.get("PBA_WEBHOOK_DB", "webhooks.sqlite")
    init_db(Receiver.db_path)
    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("PORT", "8080"))), Receiver).serve_forever()