import { ethers } from 'ethers';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 設定ファイルを読み込み
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=');
        if (key && value) {
          process.env[key.trim()] = value.trim();
        }
      }
    });
  }
}

loadEnv();

// 設定
const CONFIG = {
  // ===== sFLR (Sceptre) 設定 =====
  SFLR_DEX_PAIR_ADDRESS: '0xc9baba3f36ccaa54675deecc327ec7eaa48cb97d',
  SFLR_CONTRACT_ADDRESS: '0x12e605bc104e93b45e1ad99f9e555f659051c2bb',
  SFLR_ENABLED: process.env.SFLR_ENABLED !== 'false',
  // sFLR: DEXが安いと判定するしきい値（公式 - DEX >= この値）
  SFLR_DISCOUNT_THRESHOLD: parseFloat(process.env.SFLR_DISCOUNT_THRESHOLD || '0.025'),

  // ===== stFLR (SparkDEX) 設定 =====
  STFLR_DEX_PAIR_ADDRESS: '0x0C7E900F7a649aa8dC21a3EBbfE685596066adDA',
  STFLR_CONTRACT_ADDRESS: '0x0988C6ba244A90C07a917ebE609eB3264bE716fF',
  STFLR_ENABLED: process.env.STFLR_ENABLED === 'true',
  // stFLR: DEXが安いと判定するしきい値（公式 - DEX >= この値）
  STFLR_DISCOUNT_THRESHOLD: parseFloat(process.env.STFLR_DISCOUNT_THRESHOLD || '0.0008'),
  // stFLR: DEXが高いと判定するしきい値（公式 - DEX < この値）
  STFLR_PREMIUM_THRESHOLD: parseFloat(process.env.STFLR_PREMIUM_THRESHOLD || '-0.0002'),

  // ===== Bitcoin 設定 =====
  BTC_ENABLED: process.env.BTC_ENABLED !== 'false',
  // 前日比でこの値（%）以上下落したらアラート（マイナスで指定: -5 = 5%下落）
  BTC_DROP_THRESHOLD: parseFloat(process.env.BTC_DROP_THRESHOLD || '5.0'),
  // アラートを再送するまでの間隔（ミリ秒）: デフォルト1時間
  BTC_ALERT_COOLDOWN: parseInt(process.env.BTC_ALERT_COOLDOWN || '3600000', 10),

  // ===== 共通設定 =====
  FLARE_RPC_URL: 'https://flare-api.flare.network/ext/C/rpc',
  GMAIL_USER: process.env.GMAIL_USER || '',
  GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD || '',
  NOTIFY_EMAIL: process.env.NOTIFY_EMAIL || '',
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL || '60000', 10),
};

// BTCアラートの最終送信時刻（連続送信防止用）
let lastBtcAlertTime = 0;

// LST コントラクト ABI
const LST_ABI = [
  'function getPooledFlrByShares(uint256 _sharesAmount) view returns (uint256)',
  'function getSharesByPooledFlr(uint256 _flrAmount) view returns (uint256)',
  'function totalPooledFlr() view returns (uint256)',
  'function totalShares() view returns (uint256)',
];

/**
 * DexScreenerからLSTの価格を取得
 */
async function getDexPrice(pairAddress, tokenSymbol) {
  const url = `https://api.dexscreener.com/latest/dex/pairs/flare/${pairAddress}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.pair) {
      const priceNative = parseFloat(data.pair.priceNative);
      const baseToken = data.pair.baseToken?.symbol?.toUpperCase() || '';
      const quoteToken = data.pair.quoteToken?.symbol?.toUpperCase() || '';

      console.log(`[DexScreener ${tokenSymbol}] ペア: ${baseToken}/${quoteToken}`);
      console.log(`[DexScreener ${tokenSymbol}] priceNative: ${priceNative}`);

      const symbolVariants = tokenSymbol === 'SFLR'
        ? ['SFLR', 'STAKED FLR']
        : ['STFLR', 'ST FLR', 'STAKED FLR'];

      let lstPrice;
      if (symbolVariants.some(s => baseToken.includes(s))) {
        lstPrice = priceNative;
      } else if (symbolVariants.some(s => quoteToken.includes(s))) {
        lstPrice = 1 / priceNative;
      } else {
        console.warn(`[DexScreener ${tokenSymbol}] 警告: ${tokenSymbol}が見つかりません`);
        lstPrice = priceNative;
      }

      console.log(`[DexScreener ${tokenSymbol}] 計算後: 1 ${tokenSymbol} = ${lstPrice.toFixed(6)} WFLR`);
      return lstPrice;
    }

    throw new Error(`DexScreener APIから${tokenSymbol}ペア情報を取得できませんでした`);
  } catch (error) {
    console.error(`[DexScreener ${tokenSymbol}] エラー:`, error.message);
    throw error;
  }
}

/**
 * LSTコントラクトから公式交換レートを取得
 */
async function getExchangeRate(contractAddress, tokenName) {
  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.FLARE_RPC_URL);
    const contract = new ethers.Contract(contractAddress, LST_ABI, provider);

    const oneLST = ethers.parseEther('1');
    const flrAmount = await contract.getPooledFlrByShares(oneLST);

    const exchangeRate = parseFloat(ethers.formatEther(flrAmount));
    console.log(`[${tokenName}公式] 交換レート: 1 ${tokenName} = ${exchangeRate.toFixed(6)} FLR`);

    return exchangeRate;
  } catch (error) {
    console.error(`[${tokenName}公式] エラー:`, error.message);
    throw error;
  }
}

/**
 * CoinGecko APIからBitcoin価格と24時間変化率を取得
 */
async function getBitcoinPrice() {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,jpy&include_24hr_change=true';

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.bitcoin) {
      const priceUsd = data.bitcoin.usd;
      const priceJpy = data.bitcoin.jpy;
      const change24h = data.bitcoin.usd_24h_change;

      console.log(`[Bitcoin] 現在価格: $${priceUsd.toLocaleString()} / ¥${priceJpy.toLocaleString()}`);
      console.log(`[Bitcoin] 24時間変化率: ${change24h.toFixed(2)}%`);

      return { priceUsd, priceJpy, change24h };
    }

    throw new Error('CoinGecko APIからBitcoin価格を取得できませんでした');
  } catch (error) {
    console.error('[Bitcoin] エラー:', error.message);
    throw error;
  }
}

/**
 * Gmail経由でメール送信（LST用）
 */
async function sendEmailAlert(options) {
  const { tokenName, dexPrice, officialRate, diff, alertType, dexUrl, officialUrl } = options;

  if (!CONFIG.GMAIL_USER || !CONFIG.GMAIL_APP_PASSWORD || !CONFIG.NOTIFY_EMAIL) {
    console.warn('[Gmail] メール設定が不完全です。.envファイルを確認してください。');
    return false;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: CONFIG.GMAIL_USER,
      pass: CONFIG.GMAIL_APP_PASSWORD,
    },
  });

  let subject, alertMessage;

  if (alertType === 'dex_cheap') {
    // DEXの方が安い（公式 - DEX >= しきい値）
    subject = `💰 DEXの方が安い！${tokenName}`;
    alertMessage = `DEXでの${tokenName}価格が公式レートより安くなっています。<br><strong>FLRをスワップして${tokenName}にしろ！</strong>`;
  } else if (alertType === 'dex_premium_sflr') {
    // sFLR: DEXの方が高い（売り時）
    subject = `🚀 売り時！${tokenName}`;
    alertMessage = `<strong>FLRをステークしてsFLRにしてDEXで売れ！</strong><br>
      アンステしてる分に関してはアンステキャンセルしてDEXで売れ！`;
  } else if (alertType === 'dex_premium_stflr') {
    // stFLR: DEXの方が高い（売り時）
    subject = `🚀 売り時！${tokenName}`;
    alertMessage = `<strong>FLRをステークしてstFLRにしてDEXで売れ！</strong>`;
  }

  const mailOptions = {
    from: CONFIG.GMAIL_USER,
    to: CONFIG.NOTIFY_EMAIL,
    subject: subject,
    html: `
      <h2>${tokenName} 価格アラート</h2>
      <p>${alertMessage}</p>

      <table border="1" cellpadding="10" style="border-collapse: collapse;">
        <tr>
          <th>ソース</th>
          <th>1 ${tokenName} のレート</th>
        </tr>
        <tr>
          <td>DexScreener (DEX価格)</td>
          <td>${dexPrice.toFixed(6)} WFLR</td>
        </tr>
        <tr>
          <td>公式レート</td>
          <td>${officialRate.toFixed(6)} FLR</td>
        </tr>
      </table>

      <p><strong>差額（公式 - DEX）: ${diff.toFixed(6)} FLR</strong></p>

      <h3>リンク</h3>
      <ul>
        <li><a href="${dexUrl}">DexScreener - ${tokenName}/WFLR</a></li>
        <li><a href="${officialUrl}">公式サイト</a></li>
      </ul>

      <p style="color: gray; font-size: 12px;">
        検出時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
      </p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`[Gmail] ${tokenName}アラートメールを送信しました: ${CONFIG.NOTIFY_EMAIL}`);
    return true;
  } catch (error) {
    console.error('[Gmail] メール送信エラー:', error.message);
    return false;
  }
}

/**
 * Gmail経由でBitcoin急落アラートを送信
 */
async function sendBitcoinAlert(priceUsd, priceJpy, change24h) {
  if (!CONFIG.GMAIL_USER || !CONFIG.GMAIL_APP_PASSWORD || !CONFIG.NOTIFY_EMAIL) {
    console.warn('[Gmail] メール設定が不完全です。.envファイルを確認してください。');
    return false;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: CONFIG.GMAIL_USER,
      pass: CONFIG.GMAIL_APP_PASSWORD,
    },
  });

  const mailOptions = {
    from: CONFIG.GMAIL_USER,
    to: CONFIG.NOTIFY_EMAIL,
    subject: `📉 ビットコイン急落！前日比 ${change24h.toFixed(2)}%`,
    html: `
      <h2>⚠️ ビットコイン価格急落アラート</h2>
      <p>ビットコインが前日比 <strong style="color: red;">${change24h.toFixed(2)}%</strong> 下落しました。</p>

      <table border="1" cellpadding="10" style="border-collapse: collapse;">
        <tr>
          <th>通貨</th>
          <th>現在価格</th>
          <th>前日比</th>
        </tr>
        <tr>
          <td>USD</td>
          <td>$${priceUsd.toLocaleString()}</td>
          <td style="color: red;">${change24h.toFixed(2)}%</td>
        </tr>
        <tr>
          <td>JPY</td>
          <td>¥${priceJpy.toLocaleString()}</td>
          <td style="color: red;">${change24h.toFixed(2)}%</td>
        </tr>
      </table>

      <p style="color: gray; font-size: 12px;">
        検出時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}<br>
        ※ 次のアラートは1時間後以降に送信されます
      </p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`[Gmail] Bitcoinアラートメールを送信しました: ${CONFIG.NOTIFY_EMAIL}`);
    return true;
  } catch (error) {
    console.error('[Gmail] メール送信エラー:', error.message);
    return false;
  }
}

/**
 * sFLRの価格をチェックしてアラートを送信
 */
async function checkSflrPrice() {
  console.log('\n--- sFLR 価格チェック ---');

  try {
    const [dexPrice, officialRate] = await Promise.all([
      getDexPrice(CONFIG.SFLR_DEX_PAIR_ADDRESS, 'SFLR'),
      getExchangeRate(CONFIG.SFLR_CONTRACT_ADDRESS, 'sFLR'),
    ]);

    // 差額 = 公式 - DEX
    const diff = officialRate - dexPrice;

    console.log(`\n[sFLR 比較結果]`);
    console.log(`  DEX価格:     ${dexPrice.toFixed(6)} WFLR`);
    console.log(`  Sceptre公式: ${officialRate.toFixed(6)} FLR`);
    console.log(`  差額(公式-DEX): ${diff.toFixed(6)} FLR`);
    console.log(`  しきい値:    ${CONFIG.SFLR_DISCOUNT_THRESHOLD} FLR`);

    // 条件1: 公式 - DEX >= 0.025 → DEXの方が安い！
    if (diff >= CONFIG.SFLR_DISCOUNT_THRESHOLD) {
      console.log('💰 DEXの方が安い！');
      await sendEmailAlert({
        tokenName: 'sFLR',
        dexPrice,
        officialRate,
        diff,
        alertType: 'dex_cheap',
        dexUrl: `https://dexscreener.com/flare/${CONFIG.SFLR_DEX_PAIR_ADDRESS}`,
        officialUrl: 'https://app.sceptre.fi/flare/dashboard#stake',
      });
    }
    // 条件2: 公式 - DEX < 0 → DEXの方が高い！売り時！
    else if (diff < 0) {
      console.log('🚀 売り時！DEXの方が高い！');
      await sendEmailAlert({
        tokenName: 'sFLR',
        dexPrice,
        officialRate,
        diff,
        alertType: 'dex_premium_sflr',
        dexUrl: `https://dexscreener.com/flare/${CONFIG.SFLR_DEX_PAIR_ADDRESS}`,
        officialUrl: 'https://app.sceptre.fi/flare/dashboard#stake',
      });
    }
    // 条件なし
    else {
      console.log('✓ アラート条件を満たしていません');
    }

    return { dexPrice, officialRate, diff };
  } catch (error) {
    console.error('❌ sFLR価格チェックエラー:', error.message);
    return null;
  }
}

/**
 * stFLRの価格をチェックしてアラートを送信
 */
async function checkStflrPrice() {
  console.log('\n--- stFLR 価格チェック ---');

  try {
    const [dexPrice, officialRate] = await Promise.all([
      getDexPrice(CONFIG.STFLR_DEX_PAIR_ADDRESS, 'STFLR'),
      getExchangeRate(CONFIG.STFLR_CONTRACT_ADDRESS, 'stFLR'),
    ]);

    // 差額 = 公式 - DEX
    const diff = officialRate - dexPrice;

    console.log(`\n[stFLR 比較結果]`);
    console.log(`  DEX価格:      ${dexPrice.toFixed(6)} WFLR`);
    console.log(`  SparkDEX公式: ${officialRate.toFixed(6)} FLR`);
    console.log(`  差額(公式-DEX): ${diff.toFixed(6)} FLR`);
    console.log(`  安いしきい値: >= ${CONFIG.STFLR_DISCOUNT_THRESHOLD} FLR`);
    console.log(`  売りしきい値: < ${CONFIG.STFLR_PREMIUM_THRESHOLD} FLR`);

    // 条件1: 公式 - DEX >= 0.0008 → DEXの方が安い！
    if (diff >= CONFIG.STFLR_DISCOUNT_THRESHOLD) {
      console.log('💰 DEXの方が安い！');
      await sendEmailAlert({
        tokenName: 'stFLR',
        dexPrice,
        officialRate,
        diff,
        alertType: 'dex_cheap',
        dexUrl: `https://dexscreener.com/flare/${CONFIG.STFLR_DEX_PAIR_ADDRESS}`,
        officialUrl: 'https://sparkdex.ai/stflr/stake',
      });
    }
    // 条件2: 公式 - DEX < -0.0002 → DEXの方が高い！売り時！
    else if (diff < CONFIG.STFLR_PREMIUM_THRESHOLD) {
      console.log('🚀 売り時！DEXの方が高い！');
      await sendEmailAlert({
        tokenName: 'stFLR',
        dexPrice,
        officialRate,
        diff,
        alertType: 'dex_premium_stflr',
        dexUrl: `https://dexscreener.com/flare/${CONFIG.STFLR_DEX_PAIR_ADDRESS}`,
        officialUrl: 'https://sparkdex.ai/stflr/stake',
      });
    }
    // 条件なし
    else {
      console.log('✓ アラート条件を満たしていません');
    }

    return { dexPrice, officialRate, diff };
  } catch (error) {
    console.error('❌ stFLR価格チェックエラー:', error.message);
    return null;
  }
}

/**
 * Bitcoinの価格をチェックしてアラートを送信
 */
async function checkBitcoinPrice() {
  console.log('\n--- Bitcoin 価格チェック ---');

  try {
    const { priceUsd, priceJpy, change24h } = await getBitcoinPrice();

    // 前日比が -BTC_DROP_THRESHOLD% 以下なら急落アラート
    if (change24h <= -CONFIG.BTC_DROP_THRESHOLD) {
      const now = Date.now();
      const timeSinceLastAlert = now - lastBtcAlertTime;

      if (timeSinceLastAlert >= CONFIG.BTC_ALERT_COOLDOWN) {
        console.log(`📉 急落検出！前日比 ${change24h.toFixed(2)}%`);
        const sent = await sendBitcoinAlert(priceUsd, priceJpy, change24h);
        if (sent) {
          lastBtcAlertTime = now;
        }
      } else {
        const remainMin = Math.ceil((CONFIG.BTC_ALERT_COOLDOWN - timeSinceLastAlert) / 60000);
        console.log(`📉 急落中（前日比 ${change24h.toFixed(2)}%）- クールダウン中（あと約${remainMin}分）`);
      }
    } else {
      console.log(`✓ アラート条件を満たしていません (前日比: ${change24h.toFixed(2)}%)`);
    }

    return { priceUsd, priceJpy, change24h };
  } catch (error) {
    console.error('❌ Bitcoin価格チェックエラー:', error.message);
    return null;
  }
}

/**
 * すべての価格をチェック
 */
async function checkAllPrices() {
  console.log('\n========================================');
  console.log(`時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
  console.log('========================================');

  if (CONFIG.SFLR_ENABLED) {
    await checkSflrPrice();
  }

  if (CONFIG.STFLR_ENABLED) {
    await checkStflrPrice();
  }

  if (CONFIG.BTC_ENABLED) {
    await checkBitcoinPrice();
  }
}

/**
 * メイン関数
 */
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   LST & BTC 価格アラート モニター   ║');
  console.log('║   (sFLR / stFLR / Bitcoin)           ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`監視対象:`);
  console.log(`  sFLR (Sceptre):   ${CONFIG.SFLR_ENABLED ? '有効' : '無効'}`);
  console.log(`  stFLR (SparkDEX): ${CONFIG.STFLR_ENABLED ? '有効' : '無効'}`);
  console.log(`  Bitcoin:          ${CONFIG.BTC_ENABLED ? '有効' : '無効'}`);
  console.log(`設定:`);
  console.log(`  sFLR しきい値:    ${CONFIG.SFLR_DISCOUNT_THRESHOLD} FLR`);
  console.log(`  stFLR しきい値:   ${CONFIG.STFLR_DISCOUNT_THRESHOLD} FLR`);
  console.log(`  BTC 急落しきい値: -${CONFIG.BTC_DROP_THRESHOLD}%`);
  console.log(`  監視間隔:         ${CONFIG.CHECK_INTERVAL / 1000} 秒`);
  console.log(`  通知先:           ${CONFIG.NOTIFY_EMAIL || '(未設定)'}`);
  console.log('----------------------------------------');

  await checkAllPrices();

  setInterval(async () => {
    await checkAllPrices();
  }, CONFIG.CHECK_INTERVAL);

  console.log('\n監視を開始しました。Ctrl+C で終了します。');
}

main().catch(console.error);
