"""Minimal local web dashboard (stdlib http.server)."""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .scanner import ScanResult
from .store import Store


class LatestHolder:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._result: ScanResult | None = None

    def set(self, r: ScanResult) -> None:
        with self._lock:
            self._result = r

    def to_json(self) -> dict:
        with self._lock:
            r = self._result
        if r is None:
            return {"ts": None, "rows": [], "venues": {}, "errors": {}}
        return {"ts": r.ts, "rows": [d.to_dict() for d in r.divergences],
                "venues": r.venue_ok, "errors": r.errors, "coin_status_ok": r.coin_status_ok}


PAGE = """<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bitget Divergence Monitor</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--mut:#6b6b66;--line:#e4e3de;--pos:#b4541a;--neg:#1f6fb2;--warn:#8a6d00;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--mut:#9a9993;--line:#2e2e2b;--pos:#f0955a;--neg:#6cb2f0;--warn:#e0c060;--card:#1e1e1c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Hiragino Sans",sans-serif}
main{max-width:1200px;margin:0 auto;padding:20px 16px}h1{font-size:20px;margin:0 0 4px}
.meta{color:var(--mut);font-size:12px;margin-bottom:12px}.ctl{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 12px;align-items:center}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th{position:sticky;top:0;background:var(--card);font-weight:600;font-size:12px;color:var(--mut)}td:first-child,th:first-child{text-align:left}
.pos{color:var(--pos);font-weight:600}.neg{color:var(--neg);font-weight:600}.flag{color:var(--warn);font-size:12px}.off{color:var(--pos)}
input{width:70px;padding:3px 6px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:4px}
</style></head><body><main>
<h1>Bitget 価格乖離モニター</h1>
<div class="meta" id="meta">loading…</div>
<div class="ctl"><label>|乖離| ≥ <input id="min" type="number" step="0.1" value="0.5"> %</label>
<label><input id="rel" type="checkbox" checked style="width:auto"> 怪しい行(ref-disagree / ticker-mismatch)を除外</label>
<label><input id="wd" type="checkbox" style="width:auto"> 出金停止コインのみ</label></div>
<div class="wrap"><table><thead><tr><th>Coin</th><th>乖離%</th><th>Bitget</th><th>参照中央値</th><th>参照数</th>
<th>Bitgetで売る%</th><th>Bitgetで買う%</th><th>DEX乖離%</th><th>Bitget 24h出来高</th><th>出金</th><th>入金</th><th>flags</th></tr></thead>
<tbody id="tb"></tbody></table></div>
<p class="meta">乖離% = Bitget仲値 ÷ 他取引所仲値の中央値 − 1。「Bitgetで売る%」= Bitget買気配 ÷ 外部最安売気配 − 1（入金経由で成立）、
「Bitgetで買う%」= 外部最高買気配 ÷ Bitget売気配 − 1（出金が必要）。手数料・板の厚さ・送金時間は未考慮。</p>
</main><script>
const fmt=(v,d=2)=>v==null?"–":(+v).toFixed(d);const px=v=>v==null?"–":(+v).toPrecision(6);
const cls=v=>v==null?"":v>0?"pos":"neg";const yn=v=>v==null?"?":v?"可":"<span class=off>停止</span>";
async function load(){try{const r=await fetch("api/latest");const j=await r.json();render(j)}catch(e){document.getElementById("meta").textContent="取得失敗: "+e}}
function render(j){const min=+document.getElementById("min").value||0,rel=document.getElementById("rel").checked,wd=document.getElementById("wd").checked;
const t=j.ts?new Date(j.ts*1000).toLocaleString():"未取得";const ven=Object.entries(j.venues||{}).map(([k,v])=>k+":"+v).join(" ");
const err=Object.keys(j.errors||{}).length?" / エラー: "+Object.keys(j.errors).join(", "):"";
document.getElementById("meta").textContent=`更新 ${t} ・ ${ven}${err}`;
const rows=(j.rows||[]).filter(d=>Math.abs(d.div_pct)>=min&&(!rel||!(d.flags.includes("ref-disagree")||d.flags.includes("ticker-mismatch")))&&(!wd||d.withdrawable===false));
document.getElementById("tb").innerHTML=rows.map(d=>`<tr><td><b>${d.base}</b></td><td class="${cls(d.div_pct)}">${fmt(d.div_pct)}</td>
<td>${px(d.bitget_mid)}</td><td>${px(d.ref_mid)}</td><td title="${d.ref_venues.join(", ")}">${d.n_ref}</td>
<td class="${cls(d.sell_on_bitget_pct)}">${fmt(d.sell_on_bitget_pct)}</td><td class="${cls(d.buy_on_bitget_pct)}">${fmt(d.buy_on_bitget_pct)}</td>
<td class="${cls(d.dex_div_pct)}" title="${d.dex_info||""}">${fmt(d.dex_div_pct)}</td><td>${Math.round(d.bitget_volume).toLocaleString()}</td>
<td>${yn(d.withdrawable)}</td><td>${yn(d.depositable)}</td><td class="flag">${d.flags.join(" ")}</td></tr>`).join("")||'<tr><td colspan=12>該当なし</td></tr>';window._j=j}
for(const id of["min","rel","wd"])document.getElementById(id).addEventListener("input",()=>window._j&&render(window._j));
load();setInterval(load,15000);
</script></body></html>"""


def make_handler(latest: LatestHolder, store: Store | None):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # keep the console for alerts
            pass

        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urlparse(self.path)
            if u.path in ("/", "/index.html"):
                self._send(200, PAGE.encode(), "text/html; charset=utf-8")
            elif u.path == "/api/latest":
                self._send(200, json.dumps(latest.to_json()).encode(), "application/json")
            elif u.path == "/api/history" and store is not None:
                q = parse_qs(u.query)
                base = (q.get("base") or [""])[0]
                hours = float((q.get("hours") or ["24"])[0])
                rows = store.history(base, time.time() - hours * 3600)
                self._send(200, json.dumps(rows).encode(), "application/json")
            else:
                self._send(404, b"not found", "text/plain")

    return Handler


def start_server(host: str, port: int, latest: LatestHolder, store: Store | None) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer((host, port), make_handler(latest, store))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv
