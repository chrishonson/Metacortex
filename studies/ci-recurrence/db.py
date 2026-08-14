"""SQLite handle + tiny helpers. SQLite is the queue, cache, and checkpoint."""

from __future__ import annotations

import pathlib
import sqlite3
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).parent
DB_PATH = ROOT / "out" / "study.db"


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def connect(path: pathlib.Path | str = DB_PATH) -> sqlite3.Connection:
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.executescript((ROOT / "schema.sql").read_text())
    return con


def meta_set(con: sqlite3.Connection, key: str, value: str) -> None:
    con.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def meta_get(con: sqlite3.Connection, key: str, default: str = "") -> str:
    row = con.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default
