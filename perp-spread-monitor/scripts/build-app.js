'use strict';
// ダブルクリックで起動できる単体アプリ（Node.js 同梱。利用者は Node.js のインストール不要）を作る。
// Node.js の Single Executable Application 機能を使う。
//
// 使い方:
//   npm install
//   node scripts/build-app.js --target win-x64        → dist/win-x64/PerpSpreadMonitor/PerpSpreadMonitor.exe
//   node scripts/build-app.js --target darwin-arm64   → dist/darwin-arm64/Perp Spread Monitor.app（Mac でのみ）
//   node scripts/build-app.js --target darwin-x64     → 同上（Intel Mac 用）
//   node scripts/build-app.js --target linux-x64      → dist/linux-x64/PerpSpreadMonitor/perp-spread-monitor
//
// 埋め込む Node.js は、ビルドに使っている node と同じバージョンを nodejs.org から取得する
// （SEA の blob は同じバージョンの Node でしか読めないため）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(DIST, '.cache');
const NODE_VERSION = process.version;
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const APP_NAME = 'Perp Spread Monitor';
const BUNDLE_ID = 'local.perp-spread-monitor';
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// 単体アプリに含めるモジュール（app.js が入口）
const MODULES = ['app', 'server', 'exchanges', 'core', 'notify', 'resources', 'desktop'];
const ASSETS = {
  'index.html': path.join(ROOT, 'public', 'index.html'),
  'config.example.json': path.join(ROOT, 'config.example.json'),
};

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

function log(...a) {
  console.log('[build]', ...a);
}

// ---------- 1. 1ファイルにまとめる ----------
// SEA の入口スクリプトからは組み込みモジュールしか require できないので、自前のモジュールを1つにまとめる
function bundle() {
  const parts = MODULES.map((name) => {
    const src = fs.readFileSync(path.join(ROOT, `${name}.js`), 'utf8');
    return `${JSON.stringify(name)}: function (module, exports, require, __filename, __dirname) {\n${src}\n}`;
  });
  return `'use strict';
const __defs = {
${parts.join(',\n')}
};
const __cache = {};
const __nodeRequire = require;
const __dir = require('path').dirname(process.execPath);
function __require(id) {
  if (id.startsWith('./')) {
    const name = id.slice(2).replace(/\\.js$/, '');
    if (!__defs[name]) throw new Error('bundle: module not found: ' + id);
    if (__cache[name]) return __cache[name].exports;
    const module = { exports: {} };
    __cache[name] = module;
    __defs[name](module, module.exports, __require, __dir + '/' + name + '.js', __dir);
    return module.exports;
  }
  return __nodeRequire(id);
}
__require('./app');
`;
}

// ---------- 2. 埋め込む Node.js を取得 ----------
async function download(url, file) {
  log('download', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function nodeBinary(target) {
  fs.mkdirSync(CACHE, { recursive: true });
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const sumsFile = path.join(CACHE, `SHASUMS256-${NODE_VERSION}.txt`);
  if (!fs.existsSync(sumsFile)) await download(`${base}/SHASUMS256.txt`, sumsFile);
  const sums = new Map(
    fs.readFileSync(sumsFile, 'utf8').trim().split('\n').map((l) => {
      const [h, f] = l.trim().split(/\s+/);
      return [f, h];
    })
  );
  const remote = target === 'win-x64' ? 'win-x64/node.exe' : `node-${NODE_VERSION}-${target}.tar.gz`;
  const local = path.join(CACHE, `${NODE_VERSION}-${remote.replace(/\//g, '-')}`);
  if (!fs.existsSync(local)) await download(`${base}/${remote}`, local);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex');
  if (hash !== sums.get(remote)) throw new Error(`SHA256 が一致しません: ${remote}`);
  if (target === 'win-x64') return fs.readFileSync(local);
  const dir = path.join(CACHE, `${NODE_VERSION}-${target}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-xzf', local, '-C', dir, `node-${NODE_VERSION}-${target}/bin/node`]);
  }
  return fs.readFileSync(path.join(dir, `node-${NODE_VERSION}-${target}`, 'bin', 'node'));
}

// ---------- 3. SEA の blob を作る ----------
function makeBlob(work) {
  const main = path.join(work, 'bundle.js');
  fs.writeFileSync(main, bundle());
  const blob = path.join(work, 'sea-prep.blob');
  const config = {
    main,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: ASSETS,
  };
  const cfgPath = path.join(work, 'sea-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], { stdio: 'inherit' });
  return fs.readFileSync(blob);
}

// ---------- アイコン ----------
function iconPng(size) {
  return fs.readFileSync(path.join(ROOT, 'assets', `icon-${size}.png`));
}

// PNG を並べただけの .ico（Windows Vista 以降で使える形式）
function makeIco() {
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngs = sizes.map(iconPng);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(s >= 256 ? 0 : s, e);
    header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(pngs[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([header, ...pngs]);
}

// PNG を並べた .icns
function makeIcns() {
  const entries = [
    ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
    ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
  ].map(([type, size]) => {
    const png = iconPng(size);
    const h = Buffer.alloc(8);
    h.write(type, 0, 'ascii');
    h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const body = Buffer.concat(entries);
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'ascii');
  h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

// ---------- Windows ----------
// アイコンとバージョン情報を設定する。rcedit（Electron でも使われている Windows 用ツール）を使うので Windows 上でのみ。
// 他の OS でビルドしたときはアイコン無しになる（動作には影響しない）。
function windowsResources(file, work) {
  if (process.platform !== 'win32') {
    log('警告: Windows 以外でビルドしているため、exe のアイコン・バージョン情報は設定しません');
    return;
  }
  const ico = path.join(work, 'app.ico');
  fs.writeFileSync(ico, makeIco());
  const rcedit = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
  execFileSync(rcedit, [
    file,
    '--set-icon', ico,
    '--set-file-version', PKG.version,
    '--set-product-version', PKG.version,
    '--set-version-string', 'ProductName', APP_NAME,
    '--set-version-string', 'FileDescription', 'Perp DEX 乖離モニター',
    '--set-version-string', 'OriginalFilename', 'PerpSpreadMonitor.exe',
    '--set-version-string', 'InternalName', 'PerpSpreadMonitor',
    '--set-version-string', 'CompanyName', '',
    '--set-version-string', 'LegalCopyright', '',
  ], { stdio: 'inherit' });
}

// 実行ファイルを「コンソール(黒い画面)なし」の GUI アプリにする（PE ヘッダの Subsystem を 3→2）
function setWindowsGuiSubsystem(file) {
  const buf = fs.readFileSync(file);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('PE ヘッダが見つかりません');
  const subsystemOffset = pe + 4 + 20 + 68;
  const cur = buf.readUInt16LE(subsystemOffset);
  if (cur !== 3 && cur !== 2) throw new Error(`想定外の Subsystem: ${cur}`);
  buf.writeUInt16LE(2, subsystemOffset);
  fs.writeFileSync(file, buf);
}

// ---------- 組み立て ----------
async function inject(file, blob, target) {
  const { inject } = require('postject');
  await inject(file, 'NODE_SEA_BLOB', blob, {
    sentinelFuse: SENTINEL,
    machoSegmentName: target.startsWith('darwin') ? 'NODE_SEA' : undefined,
    overwrite: true,
  });
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>${PKG.version}</string>
  <key>CFBundleShortVersionString</key><string>${PKG.version}</string>
  <key>CFBundleExecutable</key><string>PerpSpreadMonitor</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <!-- Dock にアイコンを出さない（画面はブラウザのウィンドウ。終了は画面の「終了」ボタン） -->
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}

async function build(target) {
  const work = path.join(DIST, target, '.work');
  fs.rmSync(path.join(DIST, target), { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  log(`target=${target} node=${NODE_VERSION}`);
  const blob = makeBlob(work);
  const node = await nodeBinary(target);

  let out;
  if (target === 'win-x64') {
    const dir = path.join(DIST, target, 'PerpSpreadMonitor');
    fs.mkdirSync(dir, { recursive: true });
    out = path.join(dir, 'PerpSpreadMonitor.exe');
    fs.writeFileSync(out, node);
    // 順番が大事: リソース編集 → SEA 埋め込み → GUI 化（埋め込み後にリソースを書き換えない）
    windowsResources(out, work);
    await inject(out, blob, target);
    setWindowsGuiSubsystem(out);
    fs.copyFileSync(path.join(ROOT, 'docs', 'app-readme-windows.txt'), path.join(dir, 'はじめにお読みください.txt'));
  } else if (target.startsWith('darwin')) {
    if (process.platform !== 'darwin') throw new Error('Mac 用は Mac 上でビルドしてください（署名に codesign が必要なため）');
    const app = path.join(DIST, target, `${APP_NAME}.app`);
    const macos = path.join(app, 'Contents', 'MacOS');
    const res = path.join(app, 'Contents', 'Resources');
    fs.mkdirSync(macos, { recursive: true });
    fs.mkdirSync(res, { recursive: true });
    out = path.join(macos, 'PerpSpreadMonitor');
    fs.writeFileSync(out, node, { mode: 0o755 });
    execFileSync('codesign', ['--remove-signature', out]);
    await inject(out, blob, target);
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), infoPlist());
    fs.writeFileSync(path.join(res, 'AppIcon.icns'), makeIcns());
    // 開発者証明書は無いので「アドホック署名」（Apple Silicon では署名が無いと起動できない）
    execFileSync('codesign', ['--force', '--sign', '-', out], { stdio: 'inherit' });
    execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--verbose', app], { stdio: 'inherit' });
  } else {
    const dir = path.join(DIST, target, 'PerpSpreadMonitor');
    fs.mkdirSync(dir, { recursive: true });
    out = path.join(dir, 'perp-spread-monitor');
    fs.writeFileSync(out, node, { mode: 0o755 });
    await inject(out, blob, target);
  }
  fs.rmSync(work, { recursive: true, force: true });
  log('done:', path.relative(ROOT, out), `${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
  return out;
}

if (require.main === module) {
  const host = `${process.platform === 'win32' ? 'win' : process.platform}-${os.arch()}`;
  const target = arg('--target', host);
  if (!['win-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'].includes(target)) {
    console.error(`未対応の target: ${target}`);
    process.exit(1);
  }
  build(target).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { setWindowsGuiSubsystem, makeIco, makeIcns, bundle };
