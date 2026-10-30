/** 板の1段：[価格, 数量(BNB)] */
export type Level = [price: number, size: number];

/** 板。bids は高い順、asks は安い順（どちらも最良が先頭）。 */
export interface Book {
  bids: Level[];
  asks: Level[];
}

export type Quote = 'JPY' | 'USD' | 'USDT' | 'USDC';

/** 各取引所アダプターが返す生データ */
export interface VenueData {
  book: Book;
  /** Perpのマーク価格（取れる場合） */
  mark?: number;
  /** Perpのオラクル／インデックス価格（取れる場合） */
  index?: number;
  /** 資金調達率（1回分） */
  fundingRate?: number;
  /** 資金調達の間隔（時間） */
  fundingIntervalH?: number;
}

export interface VenueConfig {
  id: string;
  enabled: boolean;
  taker_fee: number;
  fee_checked_at?: string;
  base_url: string;
  [key: string]: unknown;
}

export interface Venue {
  id: string;
  name: string;
  kind: 'cex' | 'perp';
  quote: Quote;
  fetch(cfg: VenueConfig, timeoutMs: number): Promise<VenueData>;
}

export interface Fx {
  /** USD/JPY の仲値 */
  mid: number;
  bid?: number;
  ask?: number;
  source: string;
  /** リアルタイム（数秒単位）のレートか */
  realtime: boolean;
  /** 為替市場が閉まっている（週末など）か */
  marketClosed?: boolean;
  ts: number;
}

/** 取得結果1件（成功または失敗） */
export type VenueResult =
  | { venue: Venue; cfg: VenueConfig; ok: true; data: VenueData; ts: number; latencyMs: number }
  | { venue: Venue; cfg: VenueConfig; ok: false; error: string; ts: number };
