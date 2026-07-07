// ═══════════════════════════════════════════════════════════════
// 完成培訓證明 PDF 產生器
// pdf-lib 內建字型不支援中文，故沿用 formGenerator.js 的作法：
// 用 canvas 完整繪製整張證書 → 轉 PNG → 嵌入單頁 A4 橫式 PDF。
// 這樣中文、裝飾、排版都由 canvas 完成，不受字型限制。
// ═══════════════════════════════════════════════════════════════
import { PDFDocument } from 'pdf-lib';

// A4 橫式（單位：pt）
const PAGE_W = 842;
const PAGE_H = 595;
const DPR = 3; // 高解析，列印清晰

const FONT_FAMILY =
    '-apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif';

const formatDate = (d) => {
    const dt = d instanceof Date ? d : new Date(d || Date.now());
    return `${dt.getFullYear()} 年 ${dt.getMonth() + 1} 月 ${dt.getDate()} 日`;
};

/**
 * 在 canvas 上完整繪製證書。
 */
function drawCertificate(ctx, { name, dateText, message }) {
    const W = PAGE_W;
    const H = PAGE_H;

    // 背景（米白）
    ctx.fillStyle = '#fefdf9';
    ctx.fillRect(0, 0, W, H);

    // 外框（深藍粗框 + 內細框，雙線邊框）
    ctx.strokeStyle = '#1e3a8a';
    ctx.lineWidth = 6;
    ctx.strokeRect(24, 24, W - 48, H - 48);
    ctx.strokeStyle = '#c8a24a';
    ctx.lineWidth = 2;
    ctx.strokeRect(38, 38, W - 76, H - 76);

    ctx.textAlign = 'center';

    // 頂部小標
    ctx.fillStyle = '#c8a24a';
    ctx.font = `600 20px ${FONT_FAMILY}`;
    ctx.fillText('CERTIFICATE OF COMPLETION', W / 2, 92);

    // 主標題
    ctx.fillStyle = '#1e3a8a';
    ctx.font = `800 40px ${FONT_FAMILY}`;
    ctx.fillText('完 成 證 明', W / 2, 150);

    ctx.fillStyle = '#334155';
    ctx.font = `600 22px ${FONT_FAMILY}`;
    ctx.fillText('夢想一號魔術方塊師資培訓', W / 2, 192);

    // 分隔金線
    ctx.strokeStyle = '#c8a24a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 80, 214);
    ctx.lineTo(W / 2 + 80, 214);
    ctx.stroke();

    // 「茲證明」
    ctx.fillStyle = '#64748b';
    ctx.font = `500 20px ${FONT_FAMILY}`;
    ctx.fillText('茲 證 明', W / 2, 272);

    // 講師姓名（最醒目）
    ctx.fillStyle = '#0f172a';
    ctx.font = `800 46px ${FONT_FAMILY}`;
    ctx.fillText(name || '講師', W / 2, 328);

    // 姓名底線
    const nameWidth = Math.min(360, Math.max(160, ctx.measureText(name || '講師').width + 60));
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(W / 2 - nameWidth / 2, 348);
    ctx.lineTo(W / 2 + nameWidth / 2, 348);
    ctx.stroke();

    // 正文
    ctx.fillStyle = '#475569';
    ctx.font = `500 18px ${FONT_FAMILY}`;
    ctx.fillText('已完成本培訓課程之所有章節與考核，表現優異，特頒此證。', W / 2, 392);

    // 祝賀語
    ctx.fillStyle = '#1e3a8a';
    ctx.font = `600 17px ${FONT_FAMILY}`;
    ctx.fillText(message || '恭喜你完成培訓，成為夢想一號的正式講師！', W / 2, 428);

    // 發證日期
    ctx.fillStyle = '#64748b';
    ctx.font = `500 16px ${FONT_FAMILY}`;
    ctx.fillText(`發證日期：${dateText}`, W / 2, 486);

    // 簽署方
    ctx.fillStyle = '#334155';
    ctx.font = `700 18px ${FONT_FAMILY}`;
    ctx.fillText('夢想一號文化教育股份有限公司', W / 2, 528);

    // 右下角圓形印記
    const sex = W - 120;
    const sey = H - 120;
    ctx.strokeStyle = '#b91c1c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sex, sey, 40, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#b91c1c';
    ctx.font = `700 16px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('夢想', sex, sey - 10);
    ctx.fillText('一號', sex, sey + 10);
    ctx.textBaseline = 'alphabetic';
}

/**
 * 產生完成培訓證明的 PDF bytes。
 * @param {Object} opts
 * @param {string} opts.name    - 講師姓名
 * @param {string|Date} [opts.date] - 發證日期（預設今天）
 * @param {string} [opts.message]   - 祝賀語
 * @returns {Promise<Uint8Array>}
 */
export async function generateCertificatePdf({ name, date, message } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = PAGE_W * DPR;
    canvas.height = PAGE_H * DPR;
    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);
    drawCertificate(ctx, { name, dateText: formatDate(date), message });

    const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('建立證書影像失敗'))),
            'image/png'
        );
    });
    const pngBytes = await blob.arrayBuffer();

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    const png = await pdfDoc.embedPng(pngBytes);
    page.drawImage(png, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });

    return pdfDoc.save();
}

/**
 * 產生證書並觸發瀏覽器下載。
 */
export async function downloadCertificate({ name, date, message } = {}) {
    const bytes = await generateCertificatePdf({ name, date, message });
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const safeName = (name || 'certificate').replace(/[/\\?%*:|"<>]/g, '_');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}-完成培訓證明.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
