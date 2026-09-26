"""DEX reference prices via DexScreener's public search API.

Tickers are not unique on-chain, so we only accept pairs whose base symbol
matches exactly and pick the one with the deepest USD liquidity. Treat the
result as a sanity check, not ground truth. DexScreener prices are in USD, so
they are compared against USDT prices assuming USDT ~= 1 USD.
"""

from __future__ import annotations

import urllib.parse
from dataclasses import dataclass

from .http import fetch_json

SEARCH_URL = "https://api.dexscreener.com/latest/dex/search?q="

# Wrapped/native aliases worth trying when the plain ticker has no pools.
ALIASES = {"ETH": ["WETH"], "BTC": ["WBTC", "CBBTC"], "BNB": ["WBNB"], "AVAX": ["WAVAX"],
           "SOL": ["WSOL", "SOL"], "POL": ["WPOL"], "MATIC": ["WMATIC"]}


@dataclass(frozen=True)
class DexPrice:
    symbol: str
    price_usd: float
    liquidity_usd: float
    chain: str
    dex: str
    url: str


def pick_pair(payload: dict, symbols: list[str], min_liquidity_usd: float) -> DexPrice | None:
    wanted = {s.upper() for s in symbols}
    best: DexPrice | None = None
    for p in payload.get("pairs") or []:
        base = (p.get("baseToken") or {}).get("symbol", "").upper()
        if base not in wanted:
            continue
        try:
            price = float(p.get("priceUsd") or 0)
            liq = float((p.get("liquidity") or {}).get("usd") or 0)
        except (TypeError, ValueError):
            continue
        if price <= 0 or liq < min_liquidity_usd:
            continue
        if best is None or liq > best.liquidity_usd:
            best = DexPrice(base, price, liq, p.get("chainId", "?"), p.get("dexId", "?"), p.get("url", ""))
    return best


def fetch_dex_price(base: str, min_liquidity_usd: float = 200_000, timeout: float = 15.0) -> DexPrice | None:
    symbols = [base] + ALIASES.get(base.upper(), [])
    for query in symbols:
        payload = fetch_json(SEARCH_URL + urllib.parse.quote(query), timeout=timeout)
        found = pick_pair(payload, symbols, min_liquidity_usd)
        if found:
            return found
    return None
