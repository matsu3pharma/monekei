// 通信の共通部品：ホストごとのリクエスト間隔制御（レート制限対策）と TTL キャッシュ
const lastCall = new Map<string, Promise<void>>();

/** 同じホストへのリクエストを minIntervalMs ずつ空けて順番に送る */
export function throttle(host: string, minIntervalMs: number): Promise<void> {
  const prev = lastCall.get(host) ?? Promise.resolve();
  const next = prev.then(() => new Promise<void>((r) => setTimeout(r, minIntervalMs)));
  lastCall.set(host, next);
  return prev;
}

export interface FetchOptions {
  minIntervalMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}

export async function fetchJson<T = any>(url: string, opts: FetchOptions = {}): Promise<T> {
  const host = new URL(url).host;
  await throttle(host, opts.minIntervalMs ?? 200);
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: { accept: 'application/json', ...(opts.headers ?? {}) },
    body: opts.body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${host}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`JSONではない応答 ${host}: ${text.slice(0, 120)}`);
  }
}

/** 値を ttlMs だけ覚えておくキャッシュ。同時に来た同じキーの要求は1本にまとめる */
export class TtlCache<T> {
  private store = new Map<string, { at: number; value: Promise<T> }>();
  constructor(private ttlMs: number) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.store.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = load();
    this.store.set(key, { at: Date.now(), value });
    value.catch(() => this.store.delete(key)); // 失敗はキャッシュしない
    return value;
  }
}

/** 同時実行数を limit に抑えて map する */
export async function mapLimit<A, B>(items: A[], limit: number, fn: (a: A, i: number) => Promise<B>): Promise<B[]> {
  const out: B[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.name === 'TimeoutError' ? 'タイムアウト' : e.message;
  return String(e);
}
