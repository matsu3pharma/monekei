import json
import threading
import unittest
import urllib.request
from unittest import mock

from bitget_divergence import dex, exchanges, scanner
from bitget_divergence.analysis import compute_divergences
from bitget_divergence.bitget_status import parse_coins
from bitget_divergence.exchanges import Quote
from bitget_divergence.notify import Alerter, AlertPolicy, format_alert

BITGET = {"code": "00000", "data": [
    {"symbol": "BTCUSDT", "bidPr": "100000", "askPr": "100010", "lastPr": "100005", "usdtVolume": "9000000"},
    {"symbol": "XAUTUSDT", "bidPr": "4400", "askPr": "4404", "lastPr": "4402", "usdtVolume": "800000"},
    {"symbol": "FOOUSDT", "bidPr": "1.0", "askPr": "1.01", "lastPr": "1.0", "usdtVolume": "900000"},
    {"symbol": "TINYUSDT", "bidPr": "5", "askPr": "5.1", "lastPr": "5", "usdtVolume": "10"},
    {"symbol": "ETHBTC", "bidPr": "0.03", "askPr": "0.031", "lastPr": "0.03", "usdtVolume": "999999"},
]}
BINANCE = [
    {"symbol": "BTCUSDT", "bidPrice": "99000", "askPrice": "99010", "lastPrice": "99000", "quoteVolume": "1e9"},
    {"symbol": "FOOUSDT", "bidPrice": "1.0", "askPrice": "1.001", "lastPrice": "1", "quoteVolume": "1e6"},
]
OKX = {"data": [
    {"instId": "BTC-USDT", "bidPx": "99100", "askPx": "99110", "last": "99100", "volCcy24h": "5e8"},
    {"instId": "XAUT-USDT", "bidPx": "4200", "askPx": "4202", "last": "4201", "volCcy24h": "2e6"},
    {"instId": "FOO-USDT", "bidPx": "2.0", "askPx": "2.01", "last": "2", "volCcy24h": "1e6"},
]}
BYBIT = {"result": {"list": [
    {"symbol": "BTCUSDT", "bid1Price": "99050", "ask1Price": "99060", "lastPrice": "99050", "turnover24h": "3e8"},
    {"symbol": "XAUTUSDT", "bid1Price": "4205", "ask1Price": "4206", "lastPrice": "4205", "turnover24h": "1e6"},
]}}
GATE = [{"currency_pair": "BTC_USDT", "highest_bid": "99020", "lowest_ask": "99030", "last": "99020", "quote_volume": "1e8"}]
MEXC = [{"symbol": "BTCUSDT", "bidPrice": "99040", "askPrice": "99045", "lastPrice": "99040", "quoteVolume": "1e8"}]
KUCOIN = {"data": {"ticker": [{"symbol": "BTC-USDT", "buy": "99030", "sell": "99035", "last": "99030", "volValue": "1e8"}]}}
COINS = {"data": [
    {"coin": "BTC", "chains": [{"chain": "BTC", "withdrawable": "false", "rechargeable": "true"}]},
    {"coin": "XAUT", "chains": [{"chain": "ERC20", "withdrawable": "false", "rechargeable": "false"}]},
    {"coin": "FOO", "chains": [{"chain": "ERC20", "withdrawable": "true", "rechargeable": "true"}]},
]}
DEX_XAUT = {"pairs": [
    {"baseToken": {"symbol": "XAUT"}, "priceUsd": "4210", "liquidity": {"usd": 5_000_000}, "chainId": "ethereum", "dexId": "uniswap"},
    {"baseToken": {"symbol": "XAUT"}, "priceUsd": "9999", "liquidity": {"usd": 1_000}, "chainId": "bsc", "dexId": "pancake"},
    {"baseToken": {"symbol": "XAUTX"}, "priceUsd": "1", "liquidity": {"usd": 9e9}},
]}


def fake_fetch(url, timeout=15.0, retries=2):
    table = {
        "bitget.com/api/v2/spot/market/tickers": BITGET,
        "bitget.com/api/v2/spot/public/coins": COINS,
        "binance.com": BINANCE, "okx.com": OKX, "bybit.com": BYBIT, "gateio.ws": GATE,
        "mexc.com": MEXC, "kucoin.com": KUCOIN,
        "dexscreener.com/latest/dex/search?q=XAUT": DEX_XAUT,
    }
    for key, payload in table.items():
        if key in url:
            return payload
    return {"pairs": []}


class ParserTests(unittest.TestCase):
    def test_bitget_filters_non_usdt(self):
        q = exchanges.parse_bitget(BITGET)
        self.assertIn("BTC", q)
        self.assertNotIn("ETHBTC", q)
        self.assertNotIn("ETH", q)
        self.assertAlmostEqual(q["BTC"].mid, 100005)
        self.assertEqual(q["BTC"].quote_volume, 9_000_000)

    def test_all_reference_parsers(self):
        self.assertAlmostEqual(exchanges.parse_binance(BINANCE)["BTC"].bid, 99000)
        self.assertAlmostEqual(exchanges.parse_okx(OKX)["XAUT"].ask, 4202)
        self.assertAlmostEqual(exchanges.parse_bybit(BYBIT)["BTC"].quote_volume, 3e8)
        self.assertAlmostEqual(exchanges.parse_gate(GATE)["BTC"].bid, 99020)
        self.assertAlmostEqual(exchanges.parse_mexc(MEXC)["BTC"].ask, 99045)
        self.assertAlmostEqual(exchanges.parse_kucoin(KUCOIN)["BTC"].last, 99030)

    def test_mid_falls_back_to_last(self):
        self.assertEqual(Quote("x", "A", None, None, 2.5, 0).mid, 2.5)
        self.assertEqual(Quote("x", "A", 3, 2, 2.5, 0).mid, 2.5)  # crossed book ignored

    def test_coin_status(self):
        st = parse_coins(COINS)
        self.assertFalse(st["BTC"].withdrawable)
        self.assertTrue(st["BTC"].depositable)
        self.assertTrue(st["FOO"].withdrawable)

    def test_dex_pick_pair(self):
        p = dex.pick_pair(DEX_XAUT, ["XAUT"], 200_000)
        self.assertEqual(p.price_usd, 4210)
        self.assertEqual(p.chain, "ethereum")
        self.assertIsNone(dex.pick_pair(DEX_XAUT, ["XAUT"], 1e8))


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        self.bg = exchanges.parse_bitget(BITGET)
        self.refs = {"binance": exchanges.parse_binance(BINANCE), "okx": exchanges.parse_okx(OKX),
                     "bybit": exchanges.parse_bybit(BYBIT)}

    def test_divergence_math_and_order(self):
        divs = compute_divergences(self.bg, self.refs, coin_status=parse_coins(COINS))
        by = {d.base: d for d in divs}
        self.assertNotIn("TINY", by)  # below volume floor
        x = by["XAUT"]
        self.assertAlmostEqual(x.ref_mid, (4201 + 4205.5) / 2)
        self.assertAlmostEqual(x.div_pct, (4402 / x.ref_mid - 1) * 100)
        self.assertAlmostEqual(x.sell_on_bitget_pct, (4400 / 4202 - 1) * 100)
        self.assertIn("withdraw-off", x.flags)
        self.assertIn("deposit-off", x.flags)
        self.assertEqual(divs[0].base, "FOO")  # largest |div| first
        self.assertIn("ref-disagree", by["FOO"].flags)  # 1.0 vs 2.0 on refs
        self.assertNotIn("ref-disagree", by["BTC"].flags)
        self.assertLess(by["FOO"].div_pct, 0)

    def test_min_ref_venues(self):
        divs = compute_divergences(self.bg, self.refs, min_ref_venues=3)
        self.assertEqual([d.base for d in divs], ["BTC"])


class TickerMismatchTests(unittest.TestCase):
    def _divs(self):
        bg = {"RAIN": Quote("bitget", "RAIN", 74.4, 74.5, 74.47, 1e7),
              "DRIFT": Quote("bitget", "DRIFT", 0.01944, 0.01945, 0.01944, 1e5)}
        refs = {v: {"RAIN": Quote(v, "RAIN", 0.01085, 0.01086, 0.01085, 1e6),
                    "DRIFT": Quote(v, "DRIFT", 0.0201, 0.02011, 0.0201, 1e6)} for v in ("okx", "gate", "mexc")}
        return {d.base: d for d in compute_divergences(bg, refs)}

    def test_huge_gap_is_flagged_and_not_alerted(self):
        by = self._divs()
        self.assertIn("ticker-mismatch", by["RAIN"].flags)
        self.assertNotIn("ticker-mismatch", by["DRIFT"].flags)
        a = Alerter(AlertPolicy(threshold_pct=2.0))
        self.assertEqual([d.base for d in a.evaluate(list(by.values()), now=0)], ["DRIFT"])

    def test_implausible_dex_price_is_dropped(self):
        from bitget_divergence.analysis import attach_dex
        d = self._divs()["DRIFT"]
        self.assertFalse(attach_dex(d, 0.0001, "other token"))  # -99% like MYX/LAB
        self.assertIsNone(d.dex_price)
        self.assertTrue(attach_dex(d, 0.0202, "real pool"))
        self.assertAlmostEqual(d.dex_div_pct, (d.bitget_mid / 0.0202 - 1) * 100)


class AlertTests(unittest.TestCase):
    def test_threshold_step_cooldown_reset(self):
        bg = exchanges.parse_bitget(BITGET)
        refs = {"binance": exchanges.parse_binance(BINANCE), "okx": exchanges.parse_okx(OKX),
                "bybit": exchanges.parse_bybit(BYBIT)}
        divs = compute_divergences(bg, refs)
        a = Alerter(AlertPolicy(threshold_pct=2.0, step_pct=2.0, cooldown_s=600))
        fired = [d.base for d in a.evaluate(divs, now=0)]
        self.assertEqual(sorted(fired), ["XAUT"])  # FOO is unreliable, BTC ~0.95%
        self.assertEqual(a.evaluate(divs, now=60), [])  # same size, within cooldown
        self.assertEqual([d.base for d in a.evaluate(divs, now=700)], ["XAUT"])  # cooldown elapsed
        xaut = next(d for d in divs if d.base == "XAUT")
        xaut.div_pct += 2.5
        self.assertEqual([d.base for d in a.evaluate(divs, now=710)], ["XAUT"])  # grew by a step
        xaut.div_pct = 0.1
        a.evaluate(divs, now=720)
        xaut.div_pct = 4.0
        self.assertEqual([d.base for d in a.evaluate(divs, now=730)], ["XAUT"])  # re-armed
        self.assertIn("XAUT", format_alert(xaut))


class ScannerTests(unittest.TestCase):
    def test_end_to_end_with_partial_failure(self):
        def flaky(url, timeout=15.0, retries=2):
            if "kucoin" in url:
                raise scanner.FetchError("kucoin down")
            return fake_fetch(url)

        with mock.patch("bitget_divergence.exchanges.fetch_json", flaky), \
             mock.patch("bitget_divergence.bitget_status.fetch_json", flaky), \
             mock.patch("bitget_divergence.dex.fetch_json", flaky):
            r = scanner.run_scan(scanner.ScanConfig())
        self.assertIn("kucoin", r.errors)
        self.assertTrue(r.coin_status_ok)
        x = next(d for d in r.divergences if d.base == "XAUT")
        self.assertEqual(x.dex_price, 4210)
        self.assertAlmostEqual(x.dex_div_pct, (4402 / 4210 - 1) * 100)
        btc = next(d for d in r.divergences if d.base == "BTC")
        self.assertEqual(btc.n_ref, 6 - 1)

    def test_dashboard_serves_json(self):
        from bitget_divergence.dashboard import LatestHolder, start_server
        with mock.patch("bitget_divergence.exchanges.fetch_json", fake_fetch), \
             mock.patch("bitget_divergence.bitget_status.fetch_json", fake_fetch), \
             mock.patch("bitget_divergence.dex.fetch_json", fake_fetch):
            r = scanner.run_scan(scanner.ScanConfig(dex_top=0))
        holder = LatestHolder()
        holder.set(r)
        srv = start_server("127.0.0.1", 0, holder, None)
        try:
            port = srv.server_address[1]
            data = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/latest").read())
            self.assertTrue(any(row["base"] == "XAUT" for row in data["rows"]))
            html = urllib.request.urlopen(f"http://127.0.0.1:{port}/").read().decode()
            self.assertIn("Bitget", html)
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
