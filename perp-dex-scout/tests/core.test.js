// 実行: node --test perp-dex-scout/tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'perp-dex-scout.html'), 'utf8');
const core = html.split('// ==CORE START==')[1].split('// ==CORE END==')[0];
const ctx = { URL };
vm.runInNewContext(core + '\nObject.assign(this, { DEFAULT_CONFIG, mergeItems, classify, parseDefiLlamaProtocols, parseRaises, parseGithubPulls, parseHyperliquid, parseRssItems, parseHacks, safetyChecks, normalizeName, extractNameFromHeadline });', ctx);
const { DEFAULT_CONFIG: cfg } = ctx;
const NOW = Date.parse('2026-10-04T12:00:00Z');
const json = x => JSON.parse(JSON.stringify(x));
const daysAgo = d => NOW - d * 864e5;

test('同じ案件が2つの情報源に出たら1件にまとまる（名前一致）', () => {
  const merged = ctx.mergeItems([
    { name: 'Foo DEX', source: 'github', sourceUrl: 'https://github.com/x/1', stage: 'mainnet', url: 'https://foo.xyz', twitter: 'foo_xyz', detectedAt: daysAgo(1) },
    { name: 'Foo Finance', source: 'raises', sourceUrl: 'https://news.example/foo', stage: 'unknown', detectedAt: daysAgo(3), raise: { amount: 5 } },
  ], []);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].sources.length, 2);
  assert.strictEqual(merged[0].stage, 'mainnet');
});

test('名前が違ってもXアカウントかドメインが一致すれば同一とみなす', () => {
  const merged = ctx.mergeItems([
    { name: 'Alpha', source: 'github', sourceUrl: 'a', twitter: 'https://x.com/AlphaPerps', url: 'https://alpha.trade' },
    { name: 'Alpha Perps Exchange', source: 'defillama', sourceUrl: 'b', twitter: 'alphaperps' },
    { name: 'Beta', source: 'defillama', sourceUrl: 'c', url: 'https://app.alpha.trade/x' },
  ], []);
  assert.strictEqual(merged.length, 1);
});

test('ニュース見出しから名前を推測してまとめる', () => {
  assert.strictEqual(ctx.extractNameFromHeadline('Foo launches perp DEX on Base'), 'Foo');
  assert.strictEqual(ctx.extractNameFromHeadline('Perp DEX Foo raises $10M in seed round'), 'Foo');
  const news = ctx.parseRssItems([{ title: 'Foo raises $10M for perpetuals exchange', link: 'https://www.theblock.co/post/1', pubDate: new Date(daysAgo(1)).toUTCString() }], 'https://www.theblock.co/rss.xml', cfg, NOW);
  const merged = ctx.mergeItems([...news, { name: 'Foo', source: 'github', sourceUrl: 'g', stage: 'mainnet' }], []);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].sourceCount, 2);
});

test('2回続けて開くと、2回目は新着が0件', () => {
  const raw = [
    { name: 'Foo', source: 'github', sourceUrl: 'g1', stage: 'mainnet', detectedAt: daysAgo(1) },
    { name: 'Bar', source: 'raises', sourceUrl: 'r1', stage: 'unknown', detectedAt: daysAgo(2) },
  ];
  const r1 = ctx.classify(ctx.mergeItems(raw, []), { known: {}, hidden: {} }, NOW, cfg);
  assert.strictEqual(r1.items.filter(i => i.status === 'new').length, 2);
  const r2 = ctx.classify(ctx.mergeItems(raw, []), r1.state, NOW + 60e3, cfg);
  assert.strictEqual(r2.items.filter(i => i.status === 'new').length, 0);
  assert.strictEqual(r2.items.length, 2);
});

test('段階が進んだら続報になる', () => {
  const r1 = ctx.classify(ctx.mergeItems([{ name: 'Foo', source: 'news', sourceUrl: 'n1', stage: 'testnet', detectedAt: daysAgo(1) }], []), { known: {}, hidden: {} }, NOW, cfg);
  const r2 = ctx.classify(ctx.mergeItems([{ name: 'Foo', source: 'defillama', sourceUrl: 'd1', stage: 'mainnet', detectedAt: daysAgo(0) }], []), r1.state, NOW + 1, cfg);
  assert.strictEqual(r2.items[0].status, 'update');
  const r3 = ctx.classify(ctx.mergeItems([{ name: 'Foo', source: 'defillama', sourceUrl: 'd1', stage: 'mainnet' }], []), r2.state, NOW + 2, cfg);
  assert.strictEqual(r3.items[0].status, 'known');
});

test('興味なし・除外リスト（CEX）は出さない', () => {
  const merged = ctx.mergeItems([
    { name: 'Binance', source: 'news', sourceUrl: 'n', detectedAt: daysAgo(1) },
    { name: 'Foo', source: 'news', sourceUrl: 'n2', detectedAt: daysAgo(1) },
    { name: 'Baz', source: 'news', sourceUrl: 'n3', detectedAt: daysAgo(1) },
  ], []);
  const r = ctx.classify(merged, { known: {}, hidden: { 'n:foo': 'Foo' } }, NOW, cfg);
  assert.deepStrictEqual(json(r.items.map(i => i.name)), ['Baz']);
});

test('初回は古いものを新着にしない', () => {
  const merged = ctx.mergeItems([
    { name: 'Old', source: 'news', sourceUrl: 'a', detectedAt: daysAgo(25) },
    { name: 'HL', source: 'hyperliquid', sourceUrl: 'b', detectedAt: null },
    { name: 'Recent', source: 'news', sourceUrl: 'c', detectedAt: daysAgo(2) },
  ], []);
  const r = ctx.classify(merged, { known: {}, hidden: {} }, NOW, cfg);
  assert.deepStrictEqual(json(r.items.filter(i => i.status === 'new').map(i => i.name)), ['Recent']);
});

test('並べ順：新着の中では出典の多い順', () => {
  const merged = ctx.mergeItems([
    { name: 'One', source: 'news', sourceUrl: 'a', detectedAt: daysAgo(1) },
    { name: 'Two', source: 'news', sourceUrl: 'b', detectedAt: daysAgo(2) },
    { name: 'Two', source: 'github', sourceUrl: 'c', detectedAt: daysAgo(2) },
  ], []);
  const r = ctx.classify(merged, { known: {}, hidden: {} }, NOW, cfg);
  assert.deepStrictEqual(json(r.items.map(i => i.name)), ['Two', 'One']);
});

test('各情報源のパーサー', () => {
  const dl = ctx.parseDefiLlamaProtocols([
    { name: 'NewPerp', slug: 'newperp', category: 'Derivatives', listedAt: daysAgo(3) / 1000, url: 'https://newperp.io', twitter: 'newperp', audits: '2', tvl: 1e6, chains: ['Base'] },
    { name: 'OldPerp', slug: 'oldperp', category: 'Derivatives', listedAt: daysAgo(400) / 1000 },
    { name: 'Lend', category: 'Lending', listedAt: daysAgo(1) / 1000 },
  ], cfg, NOW);
  assert.strictEqual(dl.items.length, 1);
  assert.strictEqual(dl.index.length, 2);
  assert.strictEqual(dl.items[0].listed.audits, 2);

  const rs = ctx.parseRaises({ raises: [
    { name: 'P1', date: daysAgo(2) / 1000, category: 'Derivatives', amount: 5, round: 'Seed', leadInvestors: ['VC'] },
    { name: 'P2', date: daysAgo(2) / 1000, category: 'Lending', sector: 'Lending' },
    { name: 'P3', date: daysAgo(2) / 1000, category: 'Other', sector: 'Perpetuals DEX on Solana' },
  ] }, cfg, NOW);
  assert.deepStrictEqual(json(rs.map(r => r.name)), ['P1', 'P3']);

  const body = '##### Name (to be shown on DefiLlama):\nZeta Perps\n\n##### Twitter Link:\nhttps://twitter.com/zetaperps\n\n##### Website Link:\nhttps://zeta.trade\n\n##### Category (full list at https://defillama.com/categories) *Please choose only one:\nDerivatives\n\n##### Short Description (to be shown on DefiLlama):\nA perp dex';
  const gh = ctx.parseGithubPulls([
    { number: 1, title: 'add zeta perps', body, created_at: new Date(daysAgo(1)).toISOString(), html_url: 'https://github.com/DefiLlama/DefiLlama-Adapters/pull/1', state: 'open' },
    { number: 2, title: 'update lending adapter', body: '', created_at: new Date(daysAgo(1)).toISOString(), html_url: 'u2', state: 'open' },
    { number: 3, title: 'add lending thing', body: '##### Category:\nLending', created_at: new Date(daysAgo(1)).toISOString(), html_url: 'u3', state: 'open' },
  ], cfg, NOW);
  assert.strictEqual(gh.length, 1);
  assert.strictEqual(gh[0].name, 'Zeta Perps');
  assert.strictEqual(gh[0].twitter, 'zetaperps');
  assert.strictEqual(gh[0].url, 'https://zeta.trade');

  const hl = ctx.parseHyperliquid([null, { name: 'xyz', fullName: 'XYZ', deployer: '0x1234567890abcdef' }], 'mainnet');
  assert.strictEqual(hl.length, 1);
  assert.strictEqual(hl[0].stage, 'mainnet');
});

test('安全チェック', () => {
  const [m] = ctx.mergeItems([{ name: 'Zeta', source: 'github', sourceUrl: 'a', url: 'https://zeta.trade', twitter: 'zetaperps' }], []);
  const c = ctx.safetyChecks(m);
  assert.ok(c.some(x => x.level === 'ok' && /公式サイトと公式X/.test(x.text)));
  assert.ok(c.some(x => x.level === 'warn' && /出典が1つ/.test(x.text)));
  assert.ok(!c.some(x => /食い違う/.test(x.text)));
  const [bad] = ctx.mergeItems([{ name: 'Zeta', source: 'github', sourceUrl: 'a', url: 'https://totally-other.com', twitter: 'scammer' }], []);
  assert.ok(ctx.safetyChecks(bad).some(x => /食い違う/.test(x.text)));
});

test('掲載済みでもTVL$0・監査0・掲載直後は警告する', () => {
  const dl = ctx.parseDefiLlamaProtocols([
    { id: '9001', name: 'GDEX Perps', slug: 'gdex-perps', category: 'Derivatives', listedAt: daysAgo(2) / 1000, twitter: 'gemach_io', audits: '0', tvl: 0, chains: ['Base'] },
    { id: '9002', name: 'Solid', slug: 'solid', category: 'Derivatives', listedAt: daysAgo(400) / 1000, url: 'https://solid.xyz', twitter: 'solid', audits: '2', tvl: 5e7, audit_links: ['https://auditor.example/solid.pdf'] },
  ], { ...cfg, lookbackDays: 1000 }, NOW);
  const merged = ctx.mergeItems(dl.items, dl.index, []);
  const g = ctx.safetyChecks(merged.find(m => m.name === 'GDEX Perps'), cfg, NOW).map(c => c.text).join('|');
  assert.match(g, /監査の記録がない/);
  assert.match(g, /TVLが\$0/);
  assert.match(g, /掲載から2日/);
  const solid = merged.find(m => m.name === 'Solid');
  const s2 = ctx.safetyChecks(solid, cfg, NOW).map(c => c.text).join('|');
  assert.doesNotMatch(s2, /監査の記録がない|TVL|掲載から/);
  assert.strictEqual(solid.listed.auditLinks[0], 'https://auditor.example/solid.pdf');
});

test('ハッキング記録と名前またはIDが一致したら🚨を出す', () => {
  const hacks = ctx.parseHacks([
    { name: 'Zeta Perps', date: daysAgo(100) / 1000, amount: 12e6, technique: 'Oracle manipulation', source: 'https://rekt.example/zeta' },
    { name: 'Renamed Old Name', defillamaId: 9002, date: daysAgo(50) / 1000, amount: 1e6 },
  ]);
  const dl = ctx.parseDefiLlamaProtocols([{ id: 9002, name: 'Solid', category: 'Derivatives', listedAt: daysAgo(400) / 1000 }], cfg, NOW);
  const merged = ctx.mergeItems([
    { name: 'Zeta', source: 'news', sourceUrl: 'n1' }, { name: 'Zeta Perps DEX', source: 'raises', sourceUrl: 'r1' },
    { name: 'Solid', source: 'news', sourceUrl: 'n2' },
    { name: 'Clean', source: 'news', sourceUrl: 'n3' },
  ], dl.index, hacks);
  const by = n => merged.find(m => m.name === n);
  assert.strictEqual(by('Zeta Perps DEX').hacks.length, 1);
  assert.ok(ctx.safetyChecks(by('Zeta Perps DEX'), cfg, NOW).some(c => c.level === 'danger' && /\$12\.0M/.test(c.text)));
  assert.strictEqual(by('Solid').hacks.length, 1);
  assert.strictEqual(by('Clean').hacks.length, 0);
});

test('案件名が取れない一般ニュースは除外し、ローンチ系の記事は残す', () => {
  const d = new Date(daysAgo(1)).toUTCString();
  const items = ctx.parseRssItems([
    { title: 'Hyperliquid Policy Center, Circle press EU on perps and stablecoin reserves in MiCA review', link: 'https://a/1', pubDate: d },
    { title: 'Perps volumes hit record as traders pile in', link: 'https://a/2', pubDate: d },
    { title: 'A new perpetuals exchange on Base opens waitlist ahead of mainnet', link: 'https://a/3', pubDate: d },
    { title: 'Foo launches perp DEX on Solana', link: 'https://a/4', pubDate: d },
  ], 'https://www.theblock.co/rss.xml', cfg, NOW);
  assert.deepStrictEqual(json(items.map(i => i.sourceUrl)), ['https://a/3', 'https://a/4']);
});
