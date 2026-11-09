// 通信の共通部品：ホストごとのリクエスト間隔制御（レート制限対策）と TTL キャッシュ
const nextFree = new Map<string, number>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 同じホストへのリクエストを minIntervalMs ずつ空けて順番に送る */
export async function throttle(host: string, minIntervalMs: number): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextFree.get(host) ?? 0);
  nextFree.set(host, at + minIntervalMs);
  if (at > now) await sleep(at - now);
}

/** そのホストに次のリクエストを送れるまでの待ち時間（ms）。混んでいない提供元を選ぶのに使う */
export function waitTime(host: string): number {
  return Math.max(0, (nextFree.get(host) ?? 0) - Date.now());
}

/** 429（回数制限）を受けたら、そのホストへの送信をしばらく止める */
function backoff(host: string, ms: number) {
  nextFree.set(host, Math.max(nextFree.get(host) ?? 0, Date.now() + ms));
}

export interface FetchOptions {
  minIntervalMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /** 429・5xx のときに再試行する回数（既定 2） */
  retries?: number;
}

export async function fetchJson<T = any>(url: string, opts: FetchOptions = {}): Promise<T> {
  const host = new URL(url).host;
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    await throttle(host, opts.minIntervalMs ?? 200);
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: { accept: 'application/json', ...(opts.headers ?? {}) },
      body: opts.body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    });
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`JSONではない応答 ${host}: ${text.slice(0, 120)}`);
      }
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * (attempt + 1);
      if (res.status === 429) backoff(host, wait);
      else await sleep(wait);
      continue;
    }
    const brief = res.status === 429 ? 'リクエスト回数の制限に達しました' : text.replace(/\s+/g, ' ').slice(0, 120);
    throw new Error(`HTTP ${res.status} ${host}: ${brief}`);
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
