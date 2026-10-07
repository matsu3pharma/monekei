// ローカルで開くダッシュボード:  npm start → http://localhost:3000
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { loadConfig, ROOT } from './config.js';
import { TtlCache } from './http.js';
import { scan, type ScanResult } from './scan.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = Fastify({ logger: { level: 'warn' } });
// 同じ条件の計算は30秒使い回す（複数タブで開いても外部APIを叩きすぎない）
const results = new TtlCache<ScanResult>(30_000);

const list = (v: unknown) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

app.get('/', (_req, reply) => {
  reply.type('text/html; charset=utf-8').send(readFileSync(join(ROOT, 'public', 'index.html'), 'utf8'));
});

app.get('/favicon.ico', (_req, reply) => reply.code(204).send());

app.get('/api/config', () => {
  const cfg = loadConfig();
  return {
    amounts: cfg.amounts_jpy,
    chains: Object.values(cfg.chains).map((c) => ({ id: c.id, label: c.label })),
  };
});

app.get('/api/scan', async (req, reply) => {
  const q = req.query as Record<string, string | undefined>;
  const amounts = list(q.amounts).map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 1e10);
  const chains = list(q.chains);
  const mode = q.mode === 'maker' ? 'maker' : 'taker';
  const key = JSON.stringify([amounts.sort((a, b) => a - b), chains.sort(), mode]);
  try {
    // 設定ファイルは毎回読み直すので、routes.yaml を書き換えたら再起動なしで反映される
    return await results.get(key, () => scan({ amounts, chains, mode, config: loadConfig() }));
  } catch (e) {
    reply.code(500);
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`bitbank-dex-scout: http://localhost:${PORT} を開いてください（読み取り専用・Ctrl+C で終了）`);
});
