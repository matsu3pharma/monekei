#!/usr/bin/env python3
"""暗号資産の「いま話題」をまとめて HTML にし、ブラウザで開く。

標準ライブラリだけで動く。データ元:
  - CoinGecko トレンド (検索が急増している銘柄・カテゴリ)
  - 暗号資産ニュースの RSS (日本語・英語)
  - Reddit r/CryptoCurrency の人気投稿 (環境によっては取得できない)
X(Twitter) は API が有料のため直接は取得せず、銘柄ごとに X のリアルタイム検索へのリンクを付ける。
"""

import argparse
import concurrent.futures
import datetime as dt
import email.utils
import html
import json
import re
import sys
import urllib.parse
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
from pathlib import Path

USER_AGENT = "Mozilla/5.0 (compatible; crypto-buzz/1.0; personal use)"
TIMEOUT = 15
JST = dt.timezone(dt.timedelta(hours=9))

COINGECKO_TRENDING = "https://api.coingecko.com/api/v3/search/trending"

# (表示名, URL, 言語)
NEWS_FEEDS = [
    ("CoinPost", "https://coinpost.jp/?feed=rss2", "ja"),
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss", "en"),
    ("Cointelegraph", "https://cointelegraph.com/rss", "en"),
    ("Decrypt", "https://decrypt.co/feed", "en"),
]
REDDIT_FEED = ("Reddit r/CryptoCurrency", "https://www.reddit.com/r/CryptoCurrency/hot.rss?limit=25")

# 日本語の見出しで銘柄を拾うための別名
JA_ALIASES = {
    "BTC": ["ビットコイン"],
    "ETH": ["イーサリアム"],
    "XRP": ["リップル"],
    "SOL": ["ソラナ"],
    "DOGE": ["ドージコイン"],
    "ADA": ["カルダノ"],
    "BNB": ["バイナンスコイン"],
    "SHIB": ["柴犬コイン", "シバイヌ"],
    "PEPE": ["ペペ"],
    "SUI": ["スイ"],
}

ATOM_NS = "{http://www.w3.org/2005/Atom}"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def parse_date(text):
    if not text:
        return None
    text = text.strip()
    try:
        d = email.utils.parsedate_to_datetime(text)
    except (TypeError, ValueError):
        try:
            d = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d


def strip_tags(text):
    text = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def parse_feed(source, raw):
    """RSS 2.0 と Atom の両方を読む。"""
    root = ET.fromstring(raw)
    items = []
    for it in root.iter("item"):
        items.append({
            "source": source,
            "title": strip_tags(it.findtext("title")),
            "link": (it.findtext("link") or "").strip(),
            "date": parse_date(it.findtext("pubDate")),
            "summary": strip_tags(it.findtext("description"))[:200],
        })
    for entry in root.iter(f"{ATOM_NS}entry"):
        link_el = entry.find(f"{ATOM_NS}link")
        items.append({
            "source": source,
            "title": strip_tags(entry.findtext(f"{ATOM_NS}title")),
            "link": link_el.get("href", "") if link_el is not None else "",
            "date": parse_date(entry.findtext(f"{ATOM_NS}updated") or entry.findtext(f"{ATOM_NS}published")),
            "summary": "",
        })
    return [i for i in items if i["title"] and i["link"]]


def get_trending():
    data = json.loads(fetch(COINGECKO_TRENDING))
    coins = []
    for c in data.get("coins", []):
        item = c["item"]
        d = item.get("data") or {}
        change = (d.get("price_change_percentage_24h") or {}).get("usd")
        coins.append({
            "id": item["id"],
            "name": item["name"],
            "symbol": item["symbol"].upper(),
            "rank": item.get("market_cap_rank"),
            "thumb": item.get("small") or item.get("thumb"),
            "price": d.get("price"),
            "change": change,
        })
    categories = []
    for cat in data.get("categories", []):
        d = cat.get("data") or {}
        categories.append({
            "name": cat["name"],
            "slug": cat.get("slug"),
            "change": (d.get("market_cap_change_percentage_24h") or {}).get("usd"),
        })
    return coins, categories


def mention_patterns(coin):
    pats = []
    sym = coin["symbol"]
    if len(sym) >= 3:  # 2 文字以下の記号は誤検出が多いので名前だけで判定する
        pats.append(re.compile(rf"(?<![A-Za-z0-9$]){re.escape(sym)}(?![A-Za-z0-9])|\${re.escape(sym)}\b"))
    pats.append(re.compile(rf"(?<![A-Za-z0-9]){re.escape(coin['name'])}(?![A-Za-z0-9])", re.IGNORECASE))
    for alias in JA_ALIASES.get(sym, []):
        pats.append(re.compile(re.escape(alias)))
    return pats


def attach_mentions(coins, articles):
    for coin in coins:
        pats = mention_patterns(coin)
        coin["mentions"] = [a for a in articles if any(p.search(a["title"]) for p in pats)]


# ---------- HTML ----------

def esc(s):
    return html.escape(str(s), quote=True)


def fmt_price(p):
    if p is None:
        return "—"
    if p >= 1:
        return f"${p:,.2f}"
    return f"${p:.6g}"


def fmt_change(c):
    if c is None:
        return '<span class="chg">—</span>'
    cls = "up" if c >= 0 else "down"
    return f'<span class="chg {cls}">{c:+.1f}%</span>'


def fmt_when(d, now):
    if not d:
        return ""
    mins = int((now - d).total_seconds() // 60)
    if mins < 0:
        mins = 0
    if mins < 60:
        rel = f"{mins}分前"
    elif mins < 60 * 24:
        rel = f"{mins // 60}時間前"
    else:
        rel = f"{mins // (60 * 24)}日前"
    return f'<time title="{esc(d.astimezone(JST).strftime("%Y-%m-%d %H:%M"))}">{rel}</time>'


def x_search_url(query):
    return "https://x.com/search?" + urllib.parse.urlencode({"q": query, "f": "live"})


def article_li(a, now):
    return (
        f'<li data-src="{esc(a["source"])}"><span class="badge">{esc(a["source"])}</span>'
        f'<a href="{esc(a["link"])}" target="_blank" rel="noopener">{esc(a["title"])}</a> '
        f'{fmt_when(a["date"], now)}</li>'
    )


def render(coins, categories, articles, reddit, errors, now):
    coin_rows = []
    for i, c in enumerate(coins, 1):
        mentions = c.get("mentions", [])
        mention_html = ""
        if mentions:
            lis = "".join(article_li(a, now) for a in mentions[:8])
            mention_html = (
                f'<details><summary>関連ニュース {len(mentions)}件</summary>'
                f'<ul class="news">{lis}</ul></details>'
            )
        coin_rows.append(f"""
<li class="coin">
  <span class="num">{i}</span>
  <img src="{esc(c['thumb'])}" alt="" loading="lazy" width="32" height="32">
  <div class="coin-main">
    <div class="coin-head">
      <strong>{esc(c['name'])}</strong> <span class="sym">{esc(c['symbol'])}</span>
      <span class="rank">{'時価総額 #' + str(c['rank']) if c['rank'] else 'ランク外'}</span>
    </div>
    <div class="coin-meta">{fmt_price(c['price'])} {fmt_change(c['change'])}
      {'<span class="hot">ニュースあり</span>' if mentions else ''}</div>
    <div class="links">
      <a href="{esc(x_search_url('$' + c['symbol']))}" target="_blank" rel="noopener">X で ${esc(c['symbol'])}</a>
      <a href="{esc(x_search_url(c['name'] + ' lang:ja'))}" target="_blank" rel="noopener">X 日本語</a>
      <a href="https://www.coingecko.com/ja/coins/{esc(c['id'])}" target="_blank" rel="noopener">CoinGecko</a>
    </div>
    {mention_html}
  </div>
</li>""")

    cat_html = "".join(
        f'<li><a href="https://www.coingecko.com/ja/categories/{esc(c["slug"])}" target="_blank" rel="noopener">'
        f'{esc(c["name"])}</a> {fmt_change(c["change"])}</li>'
        for c in categories
    )

    sources = sorted({a["source"] for a in articles})
    filter_btns = '<button class="on" data-f="">すべて</button>' + "".join(
        f'<button data-f="{esc(s)}">{esc(s)}</button>' for s in sources
    )
    news_html = "".join(article_li(a, now) for a in articles[:80])
    reddit_html = "".join(article_li(a, now) for a in reddit[:25])

    err_html = ""
    if errors:
        err_html = '<div class="errors">取得できなかったデータ: ' + "、".join(esc(e) for e in errors) + "</div>"

    return f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>暗号資産 話題チェック</title>
<style>
:root {{
  --bg: #f6f7f9; --card: #fff; --text: #1b1f24; --muted: #667085; --line: #e4e7ec;
  --accent: #2f6fde; --up: #12805c; --down: #c4320a; --badge: #eef2f8; --hot: #b54708; --hotbg: #fef0c7;
}}
@media (prefers-color-scheme: dark) {{
  :root {{
    --bg: #111418; --card: #1a1e24; --text: #e6e8eb; --muted: #98a2b3; --line: #2b313a;
    --accent: #7aa7ff; --up: #3ccb8f; --down: #ff7a59; --badge: #252b34; --hot: #fdb022; --hotbg: #3a2a0a;
  }}
}}
* {{ box-sizing: border-box; }}
body {{ margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.6 system-ui, -apple-system, "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif; }}
header {{ padding: 20px 16px 8px; max-width: 1200px; margin: 0 auto; }}
h1 {{ font-size: 22px; margin: 0; }}
.updated {{ color: var(--muted); font-size: 13px; }}
main {{ max-width: 1200px; margin: 0 auto; padding: 8px 16px 40px;
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }}
@media (max-width: 860px) {{ main {{ grid-template-columns: minmax(0, 1fr); }} }}
section {{ background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; min-width: 0; }}
h2 {{ font-size: 16px; margin: 0 0 4px; }}
.note {{ color: var(--muted); font-size: 12px; margin: 0 0 12px; }}
ul {{ list-style: none; margin: 0; padding: 0; }}
a {{ color: var(--accent); text-decoration: none; }}
a:hover {{ text-decoration: underline; }}
.coin {{ display: flex; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); }}
.coin:first-child {{ border-top: 0; }}
.num {{ color: var(--muted); width: 1.5em; text-align: right; flex: none; padding-top: 4px; }}
.coin img {{ border-radius: 50%; flex: none; }}
.coin-main {{ min-width: 0; flex: 1; }}
.sym {{ color: var(--muted); font-size: 13px; }}
.rank {{ color: var(--muted); font-size: 12px; margin-left: 6px; }}
.coin-meta {{ font-size: 14px; }}
.chg.up {{ color: var(--up); }} .chg.down {{ color: var(--down); }}
.hot {{ font-size: 11px; color: var(--hot); background: var(--hotbg); border-radius: 4px; padding: 1px 6px; margin-left: 6px; }}
.links {{ display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 13px; margin-top: 2px; }}
details {{ margin-top: 4px; font-size: 13px; }}
summary {{ cursor: pointer; color: var(--muted); }}
.news li {{ padding: 6px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }}
.news li:first-child {{ border-top: 0; }}
.badge {{ display: inline-block; font-size: 11px; background: var(--badge); color: var(--muted);
  border-radius: 4px; padding: 0 6px; margin-right: 6px; }}
time {{ color: var(--muted); font-size: 12px; margin-left: 4px; white-space: nowrap; }}
.cats {{ display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 14px; }}
.filters {{ display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }}
.filters button {{ font: inherit; font-size: 12px; border: 1px solid var(--line); background: var(--card);
  color: var(--text); border-radius: 999px; padding: 2px 10px; cursor: pointer; }}
.filters button.on {{ background: var(--accent); border-color: var(--accent); color: #fff; }}
.errors {{ max-width: 1200px; margin: 8px auto 0; padding: 8px 16px; color: var(--down); font-size: 13px; }}
.stack {{ display: flex; flex-direction: column; gap: 16px; min-width: 0; }}
</style>
</head>
<body>
<header>
  <h1>暗号資産 話題チェック</h1>
  <div class="updated">取得: {now.astimezone(JST).strftime("%Y-%m-%d %H:%M")} (JST) ・ 最新にするにはショートカットをもう一度開いてください</div>
</header>
{err_html}
<main>
  <section>
    <h2>いま話題の銘柄</h2>
    <p class="note">CoinGecko で検索が急増している順。「X で $記号」から X のリアルタイム投稿を見られます。</p>
    <ul>{''.join(coin_rows) or '<li>データなし</li>'}</ul>
    {f'<h2 style="margin-top:16px">話題のカテゴリ</h2><ul class="cats">{cat_html}</ul>' if cat_html else ''}
  </section>
  <div class="stack">
    <section>
      <h2>最新ニュース</h2>
      <div class="filters" id="filters">{filter_btns}</div>
      <ul class="news" id="news">{news_html or '<li>データなし</li>'}</ul>
    </section>
    {f'<section><h2>Reddit で盛り上がっている投稿</h2><ul class="news">{reddit_html}</ul></section>' if reddit_html else ''}
  </div>
</main>
<script>
document.getElementById('filters').addEventListener('click', e => {{
  const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('#filters button').forEach(x => x.classList.toggle('on', x === b));
  const f = b.dataset.f;
  document.querySelectorAll('#news li').forEach(li => {{ li.hidden = f && li.dataset.src !== f; }});
}});
</script>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "output" / "buzz.html"),
                    help="出力する HTML のパス")
    ap.add_argument("--no-open", action="store_true", help="ブラウザを開かない")
    args = ap.parse_args()

    errors = []
    coins, categories, articles, reddit = [], [], [], []

    print("データを取得しています…")
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        trend_f = pool.submit(get_trending)
        feed_fs = {pool.submit(fetch, url): name for name, url, _ in NEWS_FEEDS}
        reddit_f = pool.submit(fetch, REDDIT_FEED[1])

        try:
            coins, categories = trend_f.result()
        except Exception as e:
            errors.append(f"CoinGecko ({e})")
        for f, name in feed_fs.items():
            try:
                articles.extend(parse_feed(name, f.result()))
            except Exception as e:
                errors.append(f"{name} ({e})")
        try:
            reddit = parse_feed("Reddit", reddit_f.result())
        except Exception as e:
            errors.append(f"Reddit ({e})")

    epoch = dt.datetime.min.replace(tzinfo=dt.timezone.utc)
    articles.sort(key=lambda a: a["date"] or epoch, reverse=True)
    attach_mentions(coins, articles)

    now = dt.datetime.now(dt.timezone.utc)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(coins, categories, articles, reddit, errors, now), encoding="utf-8")

    print(f"銘柄 {len(coins)} / ニュース {len(articles)} / Reddit {len(reddit)} 件")
    for e in errors:
        print("  取得失敗:", e, file=sys.stderr)
    print("保存先:", out)
    if not args.no_open:
        webbrowser.open(out.resolve().as_uri())


if __name__ == "__main__":
    main()
