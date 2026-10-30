import type { AppConfig } from './config.ts';
import { fetchUsdJpy } from './sources/fx.ts';
import { resolveVenues, sortBook } from './sources/venues.ts';
import type { Fx, VenueResult } from './types.ts';

export interface Snapshot {
  fx: Fx;
  results: VenueResult[];
  ts: number;
}

/** 全取引所とUSD/JPYを並列に取得する。1つが失敗しても他は止めない。 */
export async function takeSnapshot(cfg: AppConfig): Promise<Snapshot> {
  const timeout = cfg.server.timeout_ms;
  const venues = resolveVenues(cfg.venues);
  const [fx, results] = await Promise.all([
    fetchUsdJpy(cfg.fx.providers, timeout),
    Promise.all(
      venues.map(async ({ venue, cfg: vc }): Promise<VenueResult> => {
        const t0 = Date.now();
        try {
          const data = await venue.fetch(vc, timeout);
          return { venue, cfg: vc, ok: true, data: { ...data, book: sortBook(data.book) }, ts: Date.now(), latencyMs: Date.now() - t0 };
        } catch (e) {
          const err = e as Error;
          const msg = err.name === 'TimeoutError' ? 'タイムアウト' : err.message;
          return { venue, cfg: vc, ok: false, error: msg, ts: Date.now() };
        }
      }),
    ),
  ]);
  return { fx, results, ts: Date.now() };
}

/** cache_sec の間は同じスナップショットを返す（同時リクエストも1回の取得にまとめる） */
export function cachedSnapshot(cfg: AppConfig): () => Promise<Snapshot> {
  let last: { at: number; p: Promise<Snapshot> } | undefined;
  return () => {
    const now = Date.now();
    if (!last || now - last.at > cfg.server.cache_sec * 1000) {
      const p = takeSnapshot(cfg);
      last = { at: now, p };
      p.catch(() => {
        if (last?.p === p) last = undefined;
      });
    }
    return last.p;
  };
}
