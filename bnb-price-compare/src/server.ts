import { spawn } from 'node:child_process';
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
const appUrl = `http://localhost:${port}`;
/** --open：起動後にブラウザを開く（デスクトップのアイコンから起動したとき用） */
const openOnStart = process.argv.includes('--open');

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ app: 'bnb-price-compare', amounts_jpy: cfg.amounts_jpy, refresh_sec: cfg.server.refresh_sec }));
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

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

server.on('error', async (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    // すでに起動中ならブラウザだけ開いて終了する（アイコンを2回ダブルクリックしたとき）
    const running = await fetch(`${appUrl}/api/config`)
      .then((r) => r.json())
      .then((j) => j.app === 'bnb-price-compare')
      .catch(() => false);
    if (running) {
      console.log(`すでに起動しています: ${appUrl}`);
      if (openOnStart) openBrowser(appUrl);
      process.exit(0);
    }
    console.error(`ポート ${port} が別のアプリで使われています。config/venues.yaml の server.port を変えてください。`);
    process.exit(1);
  }
  throw e;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`BNB価格比較ダッシュボード: ${appUrl}`);
  if (openOnStart) {
    console.log('ブラウザを開きます。終了するときはこのウィンドウを閉じてください。');
    openBrowser(appUrl);
  }
});
