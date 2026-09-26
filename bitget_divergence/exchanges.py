"""Bulk spot ticker fetchers for Bitget and reference CEXes.

Every fetcher returns ``{BASE: Quote}`` for USDT-quoted spot pairs, so venues can
be compared symbol by symbol. Parsers are split from the network call so they
can be unit-tested against recorded payloads.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable

from .http import fetch_json

QUOTE = "USDT"


@dataclass(frozen=True)
class Quote:
    venue: str
    base: str
    bid: float | None
    ask: float | None
    last: float | None
    quote_volume: float  # 24h volume in USDT

    @property
    def mid(self) -> float | None:
        if self.bid and self.ask and self.ask >= self.bid:
            return (self.bid + self.ask) / 2
        return self.last or None

    @property
    def spread_pct(self) -> float | None:
        if self.bid and self.ask and self.bid > 0:
            return (self.ask / self.bid - 1) * 100
        return None


def _f(value: Any) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def _base_from_concat(symbol: str) -> str | None:
    symbol = symbol.upper()
    if symbol.endswith(QUOTE) and len(symbol) > len(QUOTE):
        return symbol[: -len(QUOTE)]
    return None


def _base_from_sep(symbol: str, sep: str) -> str | None:
    parts = symbol.upper().split(sep)
    if len(parts) == 2 and parts[1] == QUOTE and parts[0]:
        return parts[0]
    return None


def _collect(venue: str, rows: Iterable[tuple[str | None, Any, Any, Any, Any]]) -> dict[str, Quote]:
    out: dict[str, Quote] = {}
    for base, bid, ask, last, vol in rows:
        if not base:
            continue
        q = Quote(venue, base, _f(bid), _f(ask), _f(last), _f(vol) or 0.0)
        if q.mid is None:
            continue
        # Keep the most liquid listing if a venue somehow repeats a base.
        if base not in out or q.quote_volume > out[base].quote_volume:
            out[base] = q
    return out


# --- parsers -----------------------------------------------------------------

def parse_bitget(payload: dict) -> dict[str, Quote]:
    return _collect("bitget", (
        (_base_from_concat(t["symbol"]), t.get("bidPr"), t.get("askPr"), t.get("lastPr"),
         t.get("usdtVolume") or t.get("quoteVolume"))
        for t in payload.get("data") or []
    ))


def parse_binance(payload: list) -> dict[str, Quote]:
    return _collect("binance", (
        (_base_from_concat(t["symbol"]), t.get("bidPrice"), t.get("askPrice"), t.get("lastPrice"), t.get("quoteVolume"))
        for t in payload or []
    ))


def parse_okx(payload: dict) -> dict[str, Quote]:
    return _collect("okx", (
        (_base_from_sep(t["instId"], "-"), t.get("bidPx"), t.get("askPx"), t.get("last"), t.get("volCcy24h"))
        for t in payload.get("data") or []
    ))


def parse_bybit(payload: dict) -> dict[str, Quote]:
    return _collect("bybit", (
        (_base_from_concat(t["symbol"]), t.get("bid1Price"), t.get("ask1Price"), t.get("lastPrice"), t.get("turnover24h"))
        for t in (payload.get("result") or {}).get("list") or []
    ))


def parse_gate(payload: list) -> dict[str, Quote]:
    return _collect("gate", (
        (_base_from_sep(t["currency_pair"], "_"), t.get("highest_bid"), t.get("lowest_ask"), t.get("last"), t.get("quote_volume"))
        for t in payload or []
    ))


def parse_mexc(payload: list) -> dict[str, Quote]:
    return _collect("mexc", (
        (_base_from_concat(t["symbol"]), t.get("bidPrice"), t.get("askPrice"), t.get("lastPrice"), t.get("quoteVolume"))
        for t in payload or []
    ))


def parse_kucoin(payload: dict) -> dict[str, Quote]:
    return _collect("kucoin", (
        (_base_from_sep(t["symbol"], "-"), t.get("buy"), t.get("sell"), t.get("last"), t.get("volValue"))
        for t in ((payload.get("data") or {}).get("ticker")) or []
    ))


# --- venue registry ----------------------------------------------------------

@dataclass(frozen=True)
class Venue:
    name: str
    url: str
    parse: Callable[[Any], dict[str, Quote]]

    def fetch(self, timeout: float = 15.0) -> dict[str, Quote]:
        return self.parse(fetch_json(self.url, timeout=timeout))


BITGET = Venue("bitget", "https://api.bitget.com/api/v2/spot/market/tickers", parse_bitget)

REFERENCE_VENUES: dict[str, Venue] = {v.name: v for v in [
    Venue("binance", "https://api.binance.com/api/v3/ticker/24hr", parse_binance),
    Venue("okx", "https://www.okx.com/api/v5/market/tickers?instType=SPOT", parse_okx),
    Venue("bybit", "https://api.bybit.com/v5/market/tickers?category=spot", parse_bybit),
    Venue("gate", "https://api.gateio.ws/api/v4/spot/tickers", parse_gate),
    Venue("mexc", "https://api.mexc.com/api/v3/ticker/24hr", parse_mexc),
    Venue("kucoin", "https://api.kucoin.com/api/v1/market/allTickers", parse_kucoin),
]}
