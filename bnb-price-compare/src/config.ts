import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { VenueConfig } from './types.ts';

export interface AppConfig {
  server: { port: number; refresh_sec: number; cache_sec: number; timeout_ms: number };
  amounts_jpy: number[];
  fx: { providers: string[] };
  venues: VenueConfig[];
}

const DEFAULT_PATH = fileURLToPath(new URL('../config/venues.yaml', import.meta.url));

export function loadConfig(path = process.env.BNB_CONFIG ?? DEFAULT_PATH): AppConfig {
  const raw = parse(readFileSync(path, 'utf8')) as Partial<AppConfig>;
  return {
    server: { port: 3000, refresh_sec: 5, cache_sec: 3, timeout_ms: 8000, ...raw.server },
    amounts_jpy: raw.amounts_jpy ?? [100000],
    fx: { providers: raw.fx?.providers ?? ['gmo', 'erapi'] },
    venues: (raw.venues ?? []).map((v) => ({ ...v, enabled: v.enabled ?? true, taker_fee: v.taker_fee ?? 0 })),
  };
}
