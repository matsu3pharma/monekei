"""Per-coin deposit/withdrawal status from Bitget's public coin list."""

from __future__ import annotations

from dataclasses import dataclass

from .http import fetch_json

COINS_URL = "https://api.bitget.com/api/v2/spot/public/coins"


@dataclass(frozen=True)
class CoinStatus:
    coin: str
    withdraw_chains: tuple[str, ...]  # chains with withdrawals open
    deposit_chains: tuple[str, ...]   # chains with deposits open
    total_chains: int

    @property
    def withdrawable(self) -> bool:
        return bool(self.withdraw_chains)

    @property
    def depositable(self) -> bool:
        return bool(self.deposit_chains)


def _truthy(value: object) -> bool:
    return str(value).lower() == "true"


def parse_coins(payload: dict) -> dict[str, CoinStatus]:
    out: dict[str, CoinStatus] = {}
    for c in payload.get("data") or []:
        chains = c.get("chains") or []
        out[c["coin"].upper()] = CoinStatus(
            coin=c["coin"].upper(),
            withdraw_chains=tuple(ch.get("chain", "?") for ch in chains if _truthy(ch.get("withdrawable"))),
            deposit_chains=tuple(ch.get("chain", "?") for ch in chains if _truthy(ch.get("rechargeable"))),
            total_chains=len(chains),
        )
    return out


def fetch_coin_status(timeout: float = 15.0) -> dict[str, CoinStatus]:
    return parse_coins(fetch_json(COINS_URL, timeout=timeout))
