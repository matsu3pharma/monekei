"""Compare Bitget quotes with a cross-venue reference price."""

from __future__ import annotations

import statistics
from dataclasses import asdict, dataclass, field

from .bitget_status import CoinStatus
from .exchanges import Quote


@dataclass
class Divergence:
    base: str
    bitget_mid: float
    bitget_bid: float | None
    bitget_ask: float | None
    bitget_volume: float
    ref_mid: float
    div_pct: float                  # Bitget mid vs median external mid (+ = Bitget premium)
    n_ref: int
    ref_venues: list[str]
    ref_dispersion_pct: float       # max/min - 1 across reference mids; large = ticker collision risk
    # Executable edges, before fees and ignoring depth:
    sell_on_bitget_pct: float | None  # Bitget bid vs cheapest external ask (needs deposit to Bitget)
    buy_on_bitget_pct: float | None   # best external bid vs Bitget ask (needs withdrawal from Bitget)
    withdrawable: bool | None = None
    depositable: bool | None = None
    dex_price: float | None = None
    dex_div_pct: float | None = None
    dex_info: str | None = None
    flags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def compute_divergences(
    bitget: dict[str, Quote],
    references: dict[str, dict[str, Quote]],
    *,
    min_bitget_volume: float = 50_000,
    min_ref_volume: float = 50_000,
    min_ref_venues: int = 2,
    max_ref_dispersion_pct: float = 3.0,
    max_plausible_div_pct: float = 30.0,
    coin_status: dict[str, CoinStatus] | None = None,
) -> list[Divergence]:
    results: list[Divergence] = []
    for base, bq in bitget.items():
        if bq.quote_volume < min_bitget_volume or bq.mid is None:
            continue
        refs = [
            q for venue_quotes in references.values()
            if (q := venue_quotes.get(base)) is not None and q.mid and q.quote_volume >= min_ref_volume
        ]
        if len(refs) < min_ref_venues:
            continue

        mids = [q.mid for q in refs]
        ref_mid = statistics.median(mids)
        dispersion = (max(mids) / min(mids) - 1) * 100

        asks = [q.ask for q in refs if q.ask]
        bids = [q.bid for q in refs if q.bid]
        sell_edge = (bq.bid / min(asks) - 1) * 100 if bq.bid and asks else None
        buy_edge = (max(bids) / bq.ask - 1) * 100 if bq.ask and bids else None

        d = Divergence(
            base=base,
            bitget_mid=bq.mid,
            bitget_bid=bq.bid,
            bitget_ask=bq.ask,
            bitget_volume=bq.quote_volume,
            ref_mid=ref_mid,
            div_pct=(bq.mid / ref_mid - 1) * 100,
            n_ref=len(refs),
            ref_venues=sorted(q.venue for q in refs),
            ref_dispersion_pct=dispersion,
            sell_on_bitget_pct=sell_edge,
            buy_on_bitget_pct=buy_edge,
        )
        if dispersion > max_ref_dispersion_pct:
            d.flags.append("ref-disagree")  # external venues disagree: possibly different tokens / illiquid
        if abs(d.div_pct) > max_plausible_div_pct:
            d.flags.append("ticker-mismatch")  # Bitget likely lists a different token under this ticker
        if (bq.spread_pct or 0) > 2:
            d.flags.append("wide-spread")
        if coin_status is not None:
            st = coin_status.get(base)
            if st is not None:
                d.withdrawable = st.withdrawable
                d.depositable = st.depositable
                if not st.withdrawable:
                    d.flags.append("withdraw-off")
                if not st.depositable:
                    d.flags.append("deposit-off")
        results.append(d)

    results.sort(key=lambda d: abs(d.div_pct), reverse=True)
    return results


def attach_dex(d: Divergence, price: float, info: str, max_plausible_div_pct: float = 30.0) -> bool:
    """Attach a DEX price unless it is so far from the CEX reference that the pool is likely another token."""
    if abs((d.ref_mid / price - 1) * 100) > max_plausible_div_pct:
        return False
    d.dex_price = price
    d.dex_div_pct = (d.bitget_mid / price - 1) * 100
    d.dex_info = info
    return True


def is_reliable(d: Divergence) -> bool:
    return "ref-disagree" not in d.flags and "ticker-mismatch" not in d.flags
