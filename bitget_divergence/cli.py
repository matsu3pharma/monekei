"""Command line entry point: ``python -m bitget_divergence {scan,monitor}``."""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from datetime import datetime

from .analysis import Divergence, is_reliable
from .exchanges import REFERENCE_VENUES
from .http import FetchError
from .notify import Alerter, AlertPolicy, Notifier, format_alert
from .scanner import ScanConfig, ScanResult, run_scan


def _add_scan_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--venues", default=",".join(REFERENCE_VENUES),
                   help=f"comma-separated reference CEXes (default: all of {','.join(REFERENCE_VENUES)})")
    p.add_argument("--min-volume", type=float, default=50_000, help="min 24h USDT volume on Bitget and on each reference venue")
    p.add_argument("--min-venues", type=int, default=2, help="min number of reference venues quoting the coin")
    p.add_argument("--max-dispersion", type=float, default=3.0,
                   help="flag coin as ref-disagree when reference venues differ by more than this %%")
    p.add_argument("--dex-top", type=int, default=15, help="cross-check the top N divergences on DexScreener (0 = off)")
    p.add_argument("--dex-min-liquidity", type=float, default=200_000)
    p.add_argument("--timeout", type=float, default=15.0)


def _config(a: argparse.Namespace) -> ScanConfig:
    venues = [v.strip() for v in a.venues.split(",") if v.strip()]
    unknown = [v for v in venues if v not in REFERENCE_VENUES]
    if unknown:
        raise SystemExit(f"unknown venue(s): {', '.join(unknown)}")
    return ScanConfig(venues=venues, min_bitget_volume=a.min_volume, min_ref_volume=a.min_volume,
                      min_ref_venues=a.min_venues, max_ref_dispersion_pct=a.max_dispersion,
                      dex_top=a.dex_top, dex_min_liquidity=a.dex_min_liquidity, timeout=a.timeout)


def _fmt(v: float | None, spec: str = "+.2f") -> str:
    return "-" if v is None else format(v, spec)


def print_table(result: ScanResult, top: int, min_abs: float, show_unreliable: bool) -> None:
    ts = datetime.fromtimestamp(result.ts).strftime("%Y-%m-%d %H:%M:%S")
    print(f"# {ts}  pairs: " + " ".join(f"{k}={v}" for k, v in result.venue_ok.items()))
    for name, err in result.errors.items():
        print(f"# WARN {name}: {err}", file=sys.stderr)
    rows = [d for d in result.divergences
            if abs(d.div_pct) >= min_abs and (show_unreliable or is_reliable(d))][:top]
    hdr = f"{'COIN':<10}{'DIV%':>8}{'BITGET':>14}{'REF(med)':>14}{'N':>3}{'SELL@BG%':>10}{'BUY@BG%':>9}{'DEX%':>8}{'BG VOL':>13}  {'WD':<4}{'DEP':<4}FLAGS"
    print(hdr)
    print("-" * len(hdr))
    for d in rows:
        wd = "?" if d.withdrawable is None else ("on" if d.withdrawable else "OFF")
        dep = "?" if d.depositable is None else ("on" if d.depositable else "OFF")
        print(f"{d.base:<10}{d.div_pct:>+8.2f}{d.bitget_mid:>14.6g}{d.ref_mid:>14.6g}{d.n_ref:>3}"
              f"{_fmt(d.sell_on_bitget_pct):>10}{_fmt(d.buy_on_bitget_pct):>9}{_fmt(d.dex_div_pct):>8}"
              f"{d.bitget_volume:>13,.0f}  {wd:<4}{dep:<4}{','.join(d.flags)}")
    if not rows:
        print("(no coins above threshold)")


def write_output(path: str, divs: list[Divergence]) -> None:
    if path.endswith(".json"):
        with open(path, "w") as f:
            json.dump([d.to_dict() for d in divs], f, ensure_ascii=False, indent=1)
        return
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        cols = list(divs[0].to_dict()) if divs else []
        w.writerow(cols)
        for d in divs:
            row = d.to_dict()
            w.writerow([";".join(v) if isinstance(v, list) else v for v in (row[c] for c in cols)])


def cmd_scan(a: argparse.Namespace) -> int:
    try:
        result = run_scan(_config(a))
    except FetchError as exc:
        print(f"Bitget の取得に失敗しました: {exc}", file=sys.stderr)
        return 2
    print_table(result, a.top, a.min_div, a.show_unreliable)
    if a.output:
        write_output(a.output, result.divergences)
        print(f"# wrote {len(result.divergences)} rows to {a.output}")
    return 0


def cmd_monitor(a: argparse.Namespace) -> int:
    from .dashboard import LatestHolder, start_server
    from .store import Store

    cfg = _config(a)
    store = Store(a.db) if a.db else None
    latest = LatestHolder()
    if a.port:
        start_server(a.host, a.port, latest, store)
        print(f"# dashboard: http://{a.host}:{a.port}/")
    alerter = Alerter(AlertPolicy(threshold_pct=a.threshold, step_pct=a.step, cooldown_s=a.cooldown * 60,
                                  include_unreliable=a.show_unreliable))
    notifier = Notifier.from_env()

    while True:
        started = time.time()
        try:
            result = run_scan(cfg)
        except FetchError as exc:
            print(f"# scan failed: {exc}", file=sys.stderr)
        else:
            latest.set(result)
            if store:
                store.save(result)
            if not a.quiet:
                print_table(result, a.top, a.min_div, a.show_unreliable)
            for d in alerter.evaluate(result.divergences, result.ts):
                notifier.send(format_alert(d))
        if a.once:
            return 0
        time.sleep(max(1.0, a.interval - (time.time() - started)))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="bitget_divergence",
                                 description="Bitget と他取引所/DEX の価格乖離をスキャン・監視する")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="一回だけスキャンしてランキングを表示")
    _add_scan_args(s)
    s.add_argument("--top", type=int, default=40)
    s.add_argument("--min-div", type=float, default=0.0, help="only show |div%%| >= this")
    s.add_argument("--show-unreliable", action="store_true", help="include ref-disagree rows")
    s.add_argument("-o", "--output", help="write all rows to .csv or .json")
    s.set_defaults(func=cmd_scan)

    m = sub.add_parser("monitor", help="定期スキャン + アラート + ダッシュボード")
    _add_scan_args(m)
    m.add_argument("--interval", type=float, default=60, help="seconds between scans")
    m.add_argument("--threshold", type=float, default=2.0, help="alert when |div%%| >= this")
    m.add_argument("--step", type=float, default=2.0, help="re-alert when |div%%| grows by this much")
    m.add_argument("--cooldown", type=float, default=30, help="minutes before re-alerting the same coin")
    m.add_argument("--top", type=int, default=25)
    m.add_argument("--min-div", type=float, default=1.0)
    m.add_argument("--show-unreliable", action="store_true")
    m.add_argument("--db", default="divergence.sqlite", help="SQLite history file ('' to disable)")
    m.add_argument("--host", default="127.0.0.1")
    m.add_argument("--port", type=int, default=8765, help="dashboard port (0 = off)")
    m.add_argument("--quiet", action="store_true", help="print alerts only")
    m.add_argument("--once", action="store_true", help="run one iteration and exit")
    m.set_defaults(func=cmd_monitor)

    a = ap.parse_args(argv)
    try:
        return a.func(a)
    except KeyboardInterrupt:
        return 130
