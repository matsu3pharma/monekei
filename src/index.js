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
  // DexScreener API (sFLR/WFLR ペアアドレス - SparkDEX)
  SFLR_DEX_PAIR_ADDRESS: '0xc9baba3f36ccaa54675deecc327ec7eaa48cb97d',
  // sFLR コントラクトアドレス
  SFLR_CONTRACT_ADDRESS: '0x12e605bc104e93b45e1ad99f9e555f659051c2bb',
  // sFLR監視を有効にするか
  SFLR_ENABLED: process.env.SFLR_ENABLED !== 'false', // デフォルトtrue

  // ===== stFLR (SparkDEX) 設定 =====
  // DexScreener API (stFLR/WFLR ペアアドレス)
  STFLR_DEX_PAIR_ADDRESS: '0x0C7E900F7a649aa8dC21a3EBbfE685596066adDA',
  // stFLR コントラクトアドレス
  STFLR_CONTRACT_ADDRESS: '0x0988C6ba244A90C07a917ebE609eB3264bE716fF',
  // stFLR監視を有効にするか
  STFLR_ENABLED: process.env.STFLR_ENABLED === 'true', // デフォルトfalse

  // ===== 共通設定 =====
  // Flare RPC URL
  FLARE_RPC_URL: 'https://flare-api.flare.network/ext/C/rpc',

  // Gmail設定
  GMAIL_USER: process.env.GMAIL_USER || '',
  GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD || '',
  NOTIFY_EMAIL: process.env.NOTIFY_EMAIL || '',

  // アラートしきい値 (FLR) - 差額の絶対値がこれ以上で通知
  PRICE_DIFF_THRESHOLD: parseFloat(process.env.PRICE_DIFF_THRESHOLD || '0.15'),

  // DEX有利アラート - DEX価格が (公式レート - この値) 以上で通知
  DEX_ADVANTAGE_MARGIN: parseFloat(process.env.DEX_ADVANTAGE_MARGIN || '0.0005'),

  // DEX有利アラートを有効にするか
  DEX_ADVANTAGE_ALERT: process.env.DEX_ADVANTAGE_ALERT === 'true',

  // DEX割安アラート（stFLR用）- DEX価格が (公式レート - この値) 以下で通知
  DEX_DISCOUNT_MARGIN: parseFloat(process.env.DEX_DISCOUNT_MARGIN || '0.0005'),

  // DEX割安アラートを有効にするか
  DEX_DISCOUNT_ALERT: process.env.DEX_DISCOUNT_ALERT === 'true',

  // 監視間隔 (ミリ秒)
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL || '60000', 10),
};

// LST コントラクト ABI (sFLR, stFLR共通)
const LST_ABI = [
  'function getPooledFlrByShares(uint256 _sharesAmount) view returns (uint256)',
  'function getSharesByPooledFlr(uint256 _flrAmount) view returns (uint256)',
  'function totalPooledFlr() view returns (uint256)',
  'function totalShares() view returns (uint256)',
];

/**
 * DexScreenerからLSTの価格を取得
 * @param {string} pairAddress - ペアのコントラクトアドレス
 * @param {string} tokenSymbol - トークンシンボル（'SFLR' or 'STFLR'）
 * @returns {Promise<number>} 1 LST = X WFLR (≈ FLR)
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

      // トークンシンボルのバリエーション
      const symbolVariants = tokenSymbol === 'SFLR'
        ? ['SFLR', 'STAKED FLR']
        : ['STFLR', 'ST FLR', 'STAKED FLR'];

      let lstPrice;
      if (symbolVariants.some(s => baseToken.includes(s))) {
        lstPrice = priceNative;
      } else if (symbolVariants.some(s => quoteToken.includes(s))) {
        lstPrice = 1 / priceNative;
      } else {
        console.warn(`[DexScreener ${tokenSymbol}] 警告: ${tokenSymbol}が見つかりません (base=${baseToken}, quote=${quoteToken})`);
        lstPrice = priceNative;
      }

      console.log(`[DexScreener ${tokenSymbol}] 計算後: 1 ${tokenSymbol} = ${lstPrice.toFixed(4)} WFLR`);
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
 * @param {string} contractAddress - LSTコントラクトアドレス
 * @param {string} tokenName - トークン名（'sFLR' or 'stFLR'）
 * @returns {Promise<number>} 1 LST = X FLR
 */
async function getExchangeRate(contractAddress, tokenName) {
  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.FLARE_RPC_URL);
    const contract = new ethers.Contract(contractAddress, LST_ABI, provider);

    // 1 LST (1e18 wei) に対応する FLR 量を取得
    const oneLST = ethers.parseEther('1');
    const flrAmount = await contract.getPooledFlrByShares(oneLST);

    const exchangeRate = parseFloat(ethers.formatEther(flrAmount));
    console.log(`[${tokenName}公式] 交換レート: 1 ${tokenName} = ${exchangeRate.toFixed(4)} FLR`);

    return exchangeRate;
  } catch (error) {
    console.error(`[${tokenName}公式] エラー:`, error.message);
    throw error;
  }
}

/**
 * Gmail経由でメール送信
 * @param {object} options - メールオプション
 */
async function sendEmailAlert(options) {
  const { tokenName, dexPrice, officialRate, priceDiff, alertType, dexUrl, officialUrl } = options;

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

  const diffDirection = priceDiff > 0 ? 'DEXの方が高い' : '公式の方が高い';
  const absDiff = Math.abs(priceDiff).toFixed(4);

  // アラートタイプに応じたメッセージ
  let subject, alertMessage;
  if (alertType === 'dex_advantage') {
    subject = `🚀 DEXが有利！${tokenName}価格アラート`;
    alertMessage = `DEX価格が公式レートに近づきました（または超えました）。DEXでの売却が有利な可能性があります。`;
  } else if (alertType === 'dex_discount') {
    subject = `💰 DEXが割安！${tokenName}価格アラート`;
    alertMessage = `DEX価格が公式レートより安くなりました。DEXでの購入が有利な可能性があります。`;
  } else {
    subject = `⚠️ ${tokenName} 価格差アラート: ${absDiff} FLR の差`;
    alertMessage = `設定したしきい値 (${CONFIG.PRICE_DIFF_THRESHOLD} FLR) を超える価格差を検出しました。`;
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
          <td>${dexPrice.toFixed(4)} WFLR</td>
        </tr>
        <tr>
          <td>公式レート</td>
          <td>${officialRate.toFixed(4)} FLR</td>
        </tr>
      </table>

      <p><strong>価格差: ${absDiff} FLR (${diffDirection})</strong></p>

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
 * sFLRの価格をチェックしてアラートを送信
 */
async function checkSflrPrice() {
  console.log('\n--- sFLR 価格チェック ---');

  try {
    const [dexPrice, officialRate] = await Promise.all([
      getDexPrice(CONFIG.SFLR_DEX_PAIR_ADDRESS, 'SFLR'),
      getExchangeRate(CONFIG.SFLR_CONTRACT_ADDRESS, 'sFLR'),
    ]);

    const priceDiff = dexPrice - officialRate;
    console.log(`\n[sFLR 比較結果]`);
    console.log(`  DEX価格:     ${dexPrice.toFixed(4)} WFLR`);
    console.log(`  Sceptre公式: ${officialRate.toFixed(4)} FLR`);
    console.log(`  差額:        ${priceDiff.toFixed(4)} FLR`);

    // 条件1: 差額の絶対値がしきい値以上
    const thresholdAlert = Math.abs(priceDiff) >= CONFIG.PRICE_DIFF_THRESHOLD;

    // 条件2: DEXが有利（DEX価格 >= 公式レート - マージン）
    const dexAdvantageAlert = CONFIG.DEX_ADVANTAGE_ALERT &&
      (dexPrice >= officialRate - CONFIG.DEX_ADVANTAGE_MARGIN);

    if (thresholdAlert) {
      console.log('⚠️  しきい値を超えました！');
      await sendEmailAlert({
        tokenName: 'sFLR',
        dexPrice,
        officialRate,
        priceDiff,
        alertType: 'threshold',
        dexUrl: `https://dexscreener.com/flare/${CONFIG.SFLR_DEX_PAIR_ADDRESS}`,
        officialUrl: 'https://app.sceptre.fi/flare/dashboard#stake',
      });
    } else if (dexAdvantageAlert) {
      console.log('🚀 DEXが有利です！');
      await sendEmailAlert({
        tokenName: 'sFLR',
        dexPrice,
        officialRate,
        priceDiff,
        alertType: 'dex_advantage',
        dexUrl: `https://dexscreener.com/flare/${CONFIG.SFLR_DEX_PAIR_ADDRESS}`,
        officialUrl: 'https://app.sceptre.fi/flare/dashboard#stake',
      });
    } else {
      console.log('✓ アラート条件を満たしていません');
    }

    return { dexPrice, officialRate, priceDiff };
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

    const priceDiff = dexPrice - officialRate;
    console.log(`\n[stFLR 比較結果]`);
    console.log(`  DEX価格:      ${dexPrice.toFixed(4)} WFLR`);
    console.log(`  SparkDEX公式: ${officialRate.toFixed(4)} FLR`);
    console.log(`  差額:         ${priceDiff.toFixed(4)} FLR`);

    // 条件1: 差額の絶対値がしきい値以上
    const thresholdAlert = Math.abs(priceDiff) >= CONFIG.PRICE_DIFF_THRESHOLD;

    // 条件2: DEXが割安（DEX価格 <= 公式レート - マージン）→ 買い時
    const dexDiscountAlert = CONFIG.DEX_DISCOUNT_ALERT &&
      (dexPrice <= officialRate - CONFIG.DEX_DISCOUNT_MARGIN);

    if (thresholdAlert) {
      console.log('⚠️  しきい値を超えました！');
      await sendEmailAlert({
        tokenName: 'stFLR',
        dexPrice,
        officialRate,
        priceDiff,
        alertType: 'threshold',
        dexUrl: `https://dexscreener.com/flare/${CONFIG.STFLR_DEX_PAIR_ADDRESS}`,
        officialUrl: 'https://sparkdex.ai/stflr/stake',
      });
    } else if (dexDiscountAlert) {
      console.log('💰 DEXが割安です！');
      await sendEmailAlert({
        tokenName: 'stFLR',
        dexPrice,
        officialRate,
        priceDiff,
        alertType: 'dex_discount',
        dexUrl: `https://dexscreener.com/flare/${CONFIG.STFLR_DEX_PAIR_ADDRESS}`,
        officialUrl: 'https://sparkdex.ai/stflr/stake',
      });
    } else {
      console.log('✓ アラート条件を満たしていません');
    }

    return { dexPrice, officialRate, priceDiff };
  } catch (error) {
    console.error('❌ stFLR価格チェックエラー:', error.message);
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
}

/**
 * メイン関数
 */
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   LST 価格差アラート モニター        ║');
  console.log('║   (sFLR / stFLR)                     ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`監視対象:`);
  console.log(`  sFLR (Sceptre):   ${CONFIG.SFLR_ENABLED ? '有効' : '無効'}`);
  console.log(`  stFLR (SparkDEX): ${CONFIG.STFLR_ENABLED ? '有効' : '無効'}`);
  console.log(`設定:`);
  console.log(`  しきい値:    ±${CONFIG.PRICE_DIFF_THRESHOLD} FLR`);
  console.log(`  監視間隔:    ${CONFIG.CHECK_INTERVAL / 1000} 秒`);
  console.log(`  通知先:      ${CONFIG.NOTIFY_EMAIL || '(未設定)'}`);
  console.log('----------------------------------------');

  // 初回チェック
  await checkAllPrices();

  // 定期的にチェック
  setInterval(async () => {
    await checkAllPrices();
  }, CONFIG.CHECK_INTERVAL);

  console.log('\n監視を開始しました。Ctrl+C で終了します。');
}

// アプリ起動
main().catch(console.error);
