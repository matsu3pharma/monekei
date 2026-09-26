"""Alert state machine + webhook delivery (Discord / Slack / Telegram)."""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

from .analysis import Divergence, is_reliable


@dataclass
class AlertPolicy:
    threshold_pct: float = 2.0      # alert when |div| crosses this
    step_pct: float = 2.0           # re-alert when |div| grows by another step
    cooldown_s: float = 1800        # otherwise stay quiet this long per coin
    reset_ratio: float = 0.5        # re-arm once |div| falls below threshold * ratio
    include_unreliable: bool = False


@dataclass
class _State:
    last_alert_ts: float
    last_alert_abs: float


@dataclass
class Alerter:
    policy: AlertPolicy
    _state: dict[str, _State] = field(default_factory=dict)

    def evaluate(self, divs: list[Divergence], now: float) -> list[Divergence]:
        p = self.policy
        fired: list[Divergence] = []
        for d in divs:
            if not p.include_unreliable and not is_reliable(d):
                continue
            mag = abs(d.div_pct)
            st = self._state.get(d.base)
            if mag < p.threshold_pct * p.reset_ratio:
                self._state.pop(d.base, None)
                continue
            if mag < p.threshold_pct:
                continue
            if st is None or mag >= st.last_alert_abs + p.step_pct or now - st.last_alert_ts >= p.cooldown_s:
                self._state[d.base] = _State(now, mag)
                fired.append(d)
        return fired


def format_alert(d: Divergence) -> str:
    direction = "プレミアム(Bitgetが高い)" if d.div_pct > 0 else "ディスカウント(Bitgetが安い)"
    lines = [
        f"[Bitget乖離] {d.base}: {d.div_pct:+.2f}% {direction}",
        f"  Bitget {d.bitget_mid:.6g} / 参照中央値 {d.ref_mid:.6g} ({d.n_ref}社: {', '.join(d.ref_venues)})",
    ]
    if d.dex_price is not None:
        lines.append(f"  DEX {d.dex_price:.6g} ({d.dex_div_pct:+.2f}%, {d.dex_info})")
    if d.withdrawable is not None:
        lines.append(f"  出金: {'可' if d.withdrawable else '停止'} / 入金: {'可' if d.depositable else '停止'}")
    if d.flags:
        lines.append(f"  flags: {', '.join(d.flags)}")
    return "\n".join(lines)


def _post_json(url: str, body: dict) -> None:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=15).close()


@dataclass
class Notifier:
    discord_webhook: str | None = None
    slack_webhook: str | None = None
    telegram_token: str | None = None
    telegram_chat_id: str | None = None

    @classmethod
    def from_env(cls) -> "Notifier":
        return cls(
            discord_webhook=os.environ.get("DISCORD_WEBHOOK_URL"),
            slack_webhook=os.environ.get("SLACK_WEBHOOK_URL"),
            telegram_token=os.environ.get("TELEGRAM_BOT_TOKEN"),
            telegram_chat_id=os.environ.get("TELEGRAM_CHAT_ID"),
        )

    def send(self, text: str) -> None:
        print(text, flush=True)
        targets = []
        if self.discord_webhook:
            targets.append(("discord", lambda: _post_json(self.discord_webhook, {"content": text[:1900]})))
        if self.slack_webhook:
            targets.append(("slack", lambda: _post_json(self.slack_webhook, {"text": text})))
        if self.telegram_token and self.telegram_chat_id:
            url = f"https://api.telegram.org/bot{urllib.parse.quote(self.telegram_token)}/sendMessage"
            targets.append(("telegram", lambda: _post_json(url, {"chat_id": self.telegram_chat_id, "text": text})))
        for name, fn in targets:
            try:
                fn()
            except Exception as exc:  # never let a notification failure kill the monitor
                print(f"[notify] {name} failed: {exc}", file=sys.stderr)
