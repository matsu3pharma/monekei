"""One scan = fetch all venues in parallel, then compute divergences."""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from . import dex
from .analysis import Divergence, attach_dex, compute_divergences
from .bitget_status import CoinStatus, fetch_coin_status
from .exchanges import BITGET, REFERENCE_VENUES, Quote
from .http import FetchError


@dataclass
class ScanConfig:
    venues: list[str] = field(default_factory=lambda: list(REFERENCE_VENUES))
    min_bitget_volume: float = 50_000
    min_ref_volume: float = 50_000
    min_ref_venues: int = 2
    max_ref_dispersion_pct: float = 3.0
    max_plausible_div_pct: float = 30.0  # beyond this, assume a ticker collision
    dex_top: int = 15               # DEX-check the N largest divergences (0 = off)
    dex_min_liquidity: float = 200_000
    timeout: float = 15.0


@dataclass
class ScanResult:
    ts: float
    divergences: list[Divergence]
    venue_ok: dict[str, int]        # venue -> number of USDT pairs fetched
    errors: dict[str, str]
    coin_status_ok: bool


def run_scan(cfg: ScanConfig) -> ScanResult:
    errors: dict[str, str] = {}
    venues = [REFERENCE_VENUES[v] for v in cfg.venues]

    with ThreadPoolExecutor(max_workers=len(venues) + 2) as pool:
        bitget_f = pool.submit(BITGET.fetch, cfg.timeout)
        status_f = pool.submit(fetch_coin_status, cfg.timeout)
        ref_f = {v.name: pool.submit(v.fetch, cfg.timeout) for v in venues}

        bitget: dict[str, Quote] = bitget_f.result()  # fatal if Bitget itself is unreachable
        coin_status: dict[str, CoinStatus] | None
        try:
            coin_status = status_f.result()
        except FetchError as exc:
            coin_status = None
            errors["bitget-coins"] = str(exc)
        references: dict[str, dict[str, Quote]] = {}
        for name, fut in ref_f.items():
            try:
                references[name] = fut.result()
            except FetchError as exc:
                errors[name] = str(exc)

    divs = compute_divergences(
        bitget, references,
        min_bitget_volume=cfg.min_bitget_volume,
        min_ref_volume=cfg.min_ref_volume,
        min_ref_venues=cfg.min_ref_venues,
        max_ref_dispersion_pct=cfg.max_ref_dispersion_pct,
        max_plausible_div_pct=cfg.max_plausible_div_pct,
        coin_status=coin_status,
    )

    if cfg.dex_top > 0:
        targets = [d for d in divs if "ticker-mismatch" not in d.flags][: cfg.dex_top]
        with ThreadPoolExecutor(max_workers=4) as pool:
            futs = {d.base: pool.submit(dex.fetch_dex_price, d.base, cfg.dex_min_liquidity, cfg.timeout) for d in targets}
        for d in targets:
            try:
                price = futs[d.base].result()
            except FetchError as exc:
                errors.setdefault("dexscreener", str(exc))
                continue
            if price:
                attach_dex(d, price.price_usd, f"{price.chain}/{price.dex} liq ${price.liquidity_usd:,.0f}",
                           cfg.max_plausible_div_pct)

    venue_ok = {"bitget": len(bitget), **{k: len(v) for k, v in references.items()}}
    return ScanResult(time.time(), divs, venue_ok, errors, coin_status is not None)
