import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildComparison } from './calc/compare.ts';
import { loadConfig } from './config.ts';
import { cachedSnapshot } from './snapshot.ts';

const cfg = loadConfig();
const snapshot = cachedSnapshot(cfg);
const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const port = Number(process.env.PORT ?? cfg.server.port);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ amounts_jpy: cfg.amounts_jpy, refresh_sec: cfg.server.refresh_sec }));
    }
    if (url.pathname === '/api/compare') {
      const amount = Number(url.searchParams.get('amount') ?? cfg.amounts_jpy[0]);
      if (!(amount > 0)) throw new Error('amount は正の数で指定してください');
      const snap = await snapshot();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(buildComparison(snap.results, snap.fx, amount, snap.ts)));
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`BNB価格比較ダッシュボード: http://localhost:${port}`);
});
