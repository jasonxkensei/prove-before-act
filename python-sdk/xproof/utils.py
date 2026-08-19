"""Utility helpers for the Prove Before Act SDK."""

import hashlib
from pathlib import Path
from typing import Union

CHUNK_SIZE = 8192


def hash_file(path: Union[str, Path]) -> str:
    """Compute the SHA-256 hex digest of a file using chunked reading.

    Args:
        path: Path to the file to hash.

    Returns:
        The lowercase hex SHA-256 digest (64 characters).

    Raises:
        FileNotFoundError: If the file does not exist.
        IsADirectoryError: If the path points to a directory.
    """
    path = Path(path)
    sha256 = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(CHUNK_SIZE)
            if not chunk:
                break
            sha256.update(chunk)
    return sha256.hexdigest()


def hash_bytes(data: bytes) -> str:
    """Compute the SHA-256 hex digest of raw bytes.

    Args:
        data: The bytes to hash.

    Returns:
        The lowercase hex SHA-256 digest (64 characters).
    """
    return hashlib.sha256(data).hexdigest()
