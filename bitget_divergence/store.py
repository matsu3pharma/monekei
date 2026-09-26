"""SQLite history of scans, for charts and post-mortems."""

from __future__ import annotations

import json
import sqlite3
import threading

from .scanner import ScanResult

SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    ts REAL NOT NULL,
    base TEXT NOT NULL,
    bitget_mid REAL, ref_mid REAL, div_pct REAL,
    n_ref INTEGER, dex_price REAL, dex_div_pct REAL,
    withdrawable INTEGER, flags TEXT,
    PRIMARY KEY (ts, base)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_base_ts ON snapshots(base, ts);
"""


class Store:
    def __init__(self, path: str):
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        self._conn.executescript(SCHEMA)

    def save(self, result: ScanResult) -> None:
        rows = [
            (result.ts, d.base, d.bitget_mid, d.ref_mid, d.div_pct, d.n_ref, d.dex_price, d.dex_div_pct,
             None if d.withdrawable is None else int(d.withdrawable), json.dumps(d.flags))
            for d in result.divergences
        ]
        with self._lock, self._conn:
            self._conn.executemany("INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?,?,?,?,?,?,?)", rows)

    def history(self, base: str, since_ts: float) -> list[tuple[float, float]]:
        with self._lock:
            cur = self._conn.execute(
                "SELECT ts, div_pct FROM snapshots WHERE base = ? AND ts >= ? ORDER BY ts", (base.upper(), since_ts))
            return cur.fetchall()
