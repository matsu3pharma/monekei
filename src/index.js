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
  // DexScreener API (sFLR/WFLR ペアアドレス - BlazeSwap)
  DEXSCREENER_PAIR_ADDRESS: '0x3f50f880041521738fa88c46cdf7e0d8eeb11aa2',

  // sFLR コントラクトアドレス
  SFLR_CONTRACT_ADDRESS: '0x12e605bc104e93b45e1ad99f9e555f659051c2bb',

  // Flare RPC URL
  FLARE_RPC_URL: 'https://flare-api.flare.network/ext/C/rpc',

  // Gmail設定
  GMAIL_USER: process.env.GMAIL_USER || '',
  GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD || '',
  NOTIFY_EMAIL: process.env.NOTIFY_EMAIL || '',

  // アラートしきい値 (FLR) - 差額の絶対値がこれ以上で通知
  PRICE_DIFF_THRESHOLD: parseFloat(process.env.PRICE_DIFF_THRESHOLD || '0.15'),

  // DEX有利アラート - DEX価格が (Sceptre - この値) 以上で通知
  DEX_ADVANTAGE_MARGIN: parseFloat(process.env.DEX_ADVANTAGE_MARGIN || '0.0005'),

  // DEX有利アラートを有効にするか
  DEX_ADVANTAGE_ALERT: process.env.DEX_ADVANTAGE_ALERT === 'true',

  // 監視間隔 (ミリ秒)
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL || '60000', 10),
};

// sFLR コントラクト ABI (必要な関数のみ)
const SFLR_ABI = [
  'function getPooledFlrByShares(uint256 _sharesAmount) view returns (uint256)',
  'function getSharesByPooledFlr(uint256 _flrAmount) view returns (uint256)',
  'function totalPooledFlr() view returns (uint256)',
  'function totalShares() view returns (uint256)',
];

/**
 * DexScreenerからsFLR/WFLRの価格を取得
 * @returns {Promise<number>} 1 sFLR = X WFLR (≈ FLR)
 */
async function getDexPrice() {
  const url = `https://api.dexscreener.com/latest/dex/pairs/flare/${CONFIG.DEXSCREENER_PAIR_ADDRESS}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.pair) {
      const priceNative = parseFloat(data.pair.priceNative);
      const baseToken = data.pair.baseToken?.symbol?.toUpperCase() || '';
      const quoteToken = data.pair.quoteToken?.symbol?.toUpperCase() || '';

      console.log(`[DexScreener] ペア: ${baseToken}/${quoteToken}`);
      console.log(`[DexScreener] priceNative: ${priceNative}`);

      // baseTokenがsFLRの場合 → priceNativeはそのまま（1 sFLR = X WFLR）
      // baseTokenがWFLRの場合 → priceNativeは逆（1 WFLR = X sFLR）なので逆数を取る
      let sflrPrice;
      if (baseToken === 'SFLR' || baseToken === 'STAKED FLR') {
        sflrPrice = priceNative;
      } else if (quoteToken === 'SFLR' || quoteToken === 'STAKED FLR') {
        sflrPrice = 1 / priceNative;
      } else {
        // どちらでもない場合はpriceNativeをそのまま使う（フォールバック）
        console.warn(`[DexScreener] 警告: sFLRが見つかりません (base=${baseToken}, quote=${quoteToken})`);
        sflrPrice = priceNative;
      }

      console.log(`[DexScreener] 計算後: 1 sFLR = ${sflrPrice.toFixed(4)} WFLR`);
      return sflrPrice;
    }

    throw new Error('DexScreener APIからペア情報を取得できませんでした');
  } catch (error) {
    console.error('[DexScreener] エラー:', error.message);
    throw error;
  }
}

/**
 * Sceptre.fi コントラクトから公式交換レートを取得
 * @returns {Promise<number>} 1 sFLR = X FLR
 */
async function getSceptreExchangeRate() {
  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.FLARE_RPC_URL);
    const contract = new ethers.Contract(
      CONFIG.SFLR_CONTRACT_ADDRESS,
      SFLR_ABI,
      provider
    );

    // 1 sFLR (1e18 wei) に対応する FLR 量を取得
    const onesFLR = ethers.parseEther('1');
    const flrAmount = await contract.getPooledFlrByShares(onesFLR);

    const exchangeRate = parseFloat(ethers.formatEther(flrAmount));
    console.log(`[Sceptre.fi] 公式交換レート: 1 sFLR = ${exchangeRate.toFixed(4)} FLR`);

    return exchangeRate;
  } catch (error) {
    console.error('[Sceptre.fi] エラー:', error.message);
    throw error;
  }
}

/**
 * Gmail経由でメール送信
 * @param {string} alertType - 'threshold' または 'dex_advantage'
 */
async function sendEmailAlert(dexPrice, sceptreRate, priceDiff, alertType = 'threshold') {
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

  const diffDirection = priceDiff > 0 ? 'DEXの方が高い' : 'Sceptreの方が高い';
  const absDiff = Math.abs(priceDiff).toFixed(4);

  // アラートタイプに応じたメッセージ
  let subject, alertMessage;
  if (alertType === 'dex_advantage') {
    subject = `🚀 DEXが有利！sFLR価格アラート`;
    alertMessage = `DEX価格がSceptre公式レートに近づきました（または超えました）。DEXでの売却が有利な可能性があります。`;
  } else {
    subject = `⚠️ sFLR 価格差アラート: ${absDiff} FLR の差`;
    alertMessage = `設定したしきい値 (${CONFIG.PRICE_DIFF_THRESHOLD} FLR) を超える価格差を検出しました。`;
  }

  const mailOptions = {
    from: CONFIG.GMAIL_USER,
    to: CONFIG.NOTIFY_EMAIL,
    subject: subject,
    html: `
      <h2>sFLR 価格アラート</h2>
      <p>${alertMessage}</p>

      <table border="1" cellpadding="10" style="border-collapse: collapse;">
        <tr>
          <th>ソース</th>
          <th>1 sFLR のレート</th>
        </tr>
        <tr>
          <td>DexScreener (DEX価格)</td>
          <td>${dexPrice.toFixed(4)} WFLR</td>
        </tr>
        <tr>
          <td>Sceptre.fi (公式レート)</td>
          <td>${sceptreRate.toFixed(4)} FLR</td>
        </tr>
      </table>

      <p><strong>価格差: ${absDiff} FLR (${diffDirection})</strong></p>

      <h3>リンク</h3>
      <ul>
        <li><a href="https://dexscreener.com/flare/${CONFIG.DEXSCREENER_PAIR_ADDRESS}">DexScreener - sFLR/WFLR</a></li>
        <li><a href="https://app.sceptre.fi/flare/dashboard#stake">Sceptre.fi Dashboard</a></li>
      </ul>

      <p style="color: gray; font-size: 12px;">
        検出時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
      </p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`[Gmail] アラートメールを送信しました: ${CONFIG.NOTIFY_EMAIL}`);
    return true;
  } catch (error) {
    console.error('[Gmail] メール送信エラー:', error.message);
    return false;
  }
}

/**
 * 価格をチェックしてアラートを送信
 */
async function checkPriceAndAlert() {
  console.log('\n--- 価格チェック開始 ---');
  console.log(`時刻: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);

  try {
    // 両方の価格を同時に取得
    const [dexPrice, sceptreRate] = await Promise.all([
      getDexPrice(),
      getSceptreExchangeRate(),
    ]);

    // 価格差を計算 (DEX価格 - Sceptre公式レート)
    const priceDiff = dexPrice - sceptreRate;
    console.log(`\n[比較結果]`);
    console.log(`  DEX価格:       ${dexPrice.toFixed(4)} WFLR`);
    console.log(`  Sceptre公式:   ${sceptreRate.toFixed(4)} FLR`);
    console.log(`  差額:          ${priceDiff.toFixed(4)} FLR`);
    console.log(`  しきい値:      ±${CONFIG.PRICE_DIFF_THRESHOLD} FLR`);
    if (CONFIG.DEX_ADVANTAGE_ALERT) {
      console.log(`  DEX有利判定:   DEX >= Sceptre - ${CONFIG.DEX_ADVANTAGE_MARGIN}`);
    }

    // 条件1: 差額の絶対値がしきい値以上
    const thresholdAlert = Math.abs(priceDiff) >= CONFIG.PRICE_DIFF_THRESHOLD;

    // 条件2: DEXが有利（DEX価格 >= Sceptre価格 - マージン）
    const dexAdvantageAlert = CONFIG.DEX_ADVANTAGE_ALERT &&
      (dexPrice >= sceptreRate - CONFIG.DEX_ADVANTAGE_MARGIN);

    // どちらかの条件を満たしたらアラート
    if (thresholdAlert) {
      console.log('\n⚠️  しきい値を超えました！アラートを送信します...');
      await sendEmailAlert(dexPrice, sceptreRate, priceDiff, 'threshold');
    } else if (dexAdvantageAlert) {
      console.log('\n⚠️  DEXが有利です！アラートを送信します...');
      await sendEmailAlert(dexPrice, sceptreRate, priceDiff, 'dex_advantage');
    } else {
      console.log('\n✓ アラート条件を満たしていません');
    }

    return { dexPrice, sceptreRate, priceDiff };
  } catch (error) {
    console.error('\n❌ 価格チェックエラー:', error.message);
    return null;
  }
}

/**
 * メイン関数
 */
async function main() {
  console.log('========================================');
  console.log('  sFLR 価格差アラート モニター');
  console.log('========================================');
  console.log(`しきい値: ${CONFIG.PRICE_DIFF_THRESHOLD} FLR`);
  console.log(`監視間隔: ${CONFIG.CHECK_INTERVAL / 1000} 秒`);
  console.log(`通知先: ${CONFIG.NOTIFY_EMAIL || '(未設定)'}`);
  console.log('----------------------------------------\n');

  // 初回チェック
  await checkPriceAndAlert();

  // 定期的にチェック
  setInterval(async () => {
    await checkPriceAndAlert();
  }, CONFIG.CHECK_INTERVAL);

  console.log('\n監視を開始しました。Ctrl+C で終了します。');
}

// アプリ起動
main().catch(console.error);
