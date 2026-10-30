export async function fetchJson<T = any>(
  url: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
  });
  if (!res.ok) {
    const hint = res.status === 451 ? '（この地域からはアクセス不可）' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  return (await res.json()) as T;
}

/** 文字列/数値の配列ペアを Level に変換し、数量0や不正値を除く */
export function toLevels(rows: Array<[unknown, unknown]>): [number, number][] {
  return rows
    .map(([p, s]) => [Number(p), Number(s)] as [number, number])
    .filter(([p, s]) => Number.isFinite(p) && Number.isFinite(s) && p > 0 && s > 0);
}
