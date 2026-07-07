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

// 色票
const NAVY = '#1e3a8a';
const NAVY_DEEP = '#0f172a';
const GOLD = '#c19a3e';
const GOLD_LIGHT = '#e6c874';
const GOLD_DEEP = '#9a7420';
const CREAM = '#fdfbf5';
const INK = '#475569';
const MUTE = '#64748b';

const formatDate = (d) => {
    const dt = d instanceof Date ? d : new Date(d || Date.now());
    return `${dt.getFullYear()} 年 ${dt.getMonth() + 1} 月 ${dt.getDate()} 日`;
};

// 由姓名 + 日期推出穩定的證書編號（同一份下載得到相同編號）
const certificateNo = (name, dt) => {
    const seedStr = `${name || ''}|${dt.getFullYear()}-${dt.getMonth() + 1}-${dt.getDate()}`;
    let h = 0;
    for (let i = 0; i < seedStr.length; i++) {
        h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
    }
    const serial = (h % 1000000).toString().padStart(6, '0');
    return `DO-${dt.getFullYear()}-${serial}`;
};

// 置中金線 + 中央菱形
function goldDivider(ctx, cx, y, half) {
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx - half, y);
    ctx.lineTo(cx - 8, y);
    ctx.moveTo(cx + 8, y);
    ctx.lineTo(cx + half, y);
    ctx.stroke();
    // 中央菱形
    ctx.fillStyle = GOLD;
    ctx.save();
    ctx.translate(cx, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-3.5, -3.5, 7, 7);
    ctx.restore();
}

// 四角裝飾（L 形雙線 + 小菱形）
function cornerOrnament(ctx, x, y, sx, sy) {
    const len = 34;
    const gap = 7;
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y + sy * len);
    ctx.lineTo(x, y);
    ctx.lineTo(x + sx * len, y);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + sx * gap, y + sy * (len - 6));
    ctx.lineTo(x + sx * gap, y + sy * gap);
    ctx.lineTo(x + sx * (len - 6), y + sy * gap);
    ctx.stroke();
    // 角落小菱形
    ctx.fillStyle = GOLD;
    ctx.save();
    ctx.translate(x + sx * (len + 6), y + sy * (len + 6));
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-2.5, -2.5, 5, 5);
    ctx.restore();
}

// 浮水印底紋：中央淡金同心圓 + 交疊圓（guilloché 感）
function watermark(ctx, cx, cy) {
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1;
    for (let r = 60; r <= 210; r += 18) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
    }
    // 花瓣狀交疊圓
    const petals = 12;
    const pr = 120;
    for (let i = 0; i < petals; i++) {
        const a = (i / petals) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * pr, cy + Math.sin(a) * pr, pr, 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.restore();
}

// 金色印璽（扇貝邊獎章 + 紅緞帶 + 中央文字）
function drawSeal(ctx, cx, cy, R) {
    ctx.save();

    // 緞帶尾（深紅）
    ctx.fillStyle = '#9f1239';
    const bw = R * 0.42;
    const by = cy + R * 0.55;
    // 左尾
    ctx.beginPath();
    ctx.moveTo(cx - bw, by);
    ctx.lineTo(cx - bw * 0.35, by);
    ctx.lineTo(cx - bw * 0.55, by + R * 0.9);
    ctx.lineTo(cx - bw * 0.9, by + R * 0.72);
    ctx.closePath();
    ctx.fill();
    // 右尾
    ctx.beginPath();
    ctx.moveTo(cx + bw, by);
    ctx.lineTo(cx + bw * 0.35, by);
    ctx.lineTo(cx + bw * 0.55, by + R * 0.9);
    ctx.lineTo(cx + bw * 0.9, by + R * 0.72);
    ctx.closePath();
    ctx.fill();

    // 扇貝外緣
    const scallops = 24;
    ctx.fillStyle = GOLD;
    for (let i = 0; i < scallops; i++) {
        const a = (i / scallops) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * R, cy + Math.sin(a) * R, R * 0.14, 0, Math.PI * 2);
        ctx.fill();
    }

    // 主體漸層金圓盤
    const g = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R);
    g.addColorStop(0, GOLD_LIGHT);
    g.addColorStop(0.55, GOLD);
    g.addColorStop(1, GOLD_DEEP);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    // 內圈（深金描邊）
    ctx.strokeStyle = GOLD_DEEP;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.78, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.72, 0, Math.PI * 2);
    ctx.stroke();

    // 兩環間的小圓點
    const dots = 32;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = 0; i < dots; i++) {
        const a = (i / dots) * Math.PI * 2;
        const rr = R * 0.86;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 1.2, 0, Math.PI * 2);
        ctx.fill();
    }

    // 頂端小星
    ctx.fillStyle = NAVY;
    drawStar(ctx, cx, cy - R * 0.42, 5, 6, 2.6);

    // 中央文字
    ctx.fillStyle = NAVY;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${R * 0.34}px ${FONT_FAMILY}`;
    ctx.fillText('夢想', cx, cy - R * 0.12);
    ctx.fillText('一號', cx, cy + R * 0.22);
    ctx.font = `600 ${R * 0.14}px ${FONT_FAMILY}`;
    ctx.fillStyle = GOLD_DEEP;
    ctx.fillText('官方認證', cx, cy + R * 0.55);

    ctx.textBaseline = 'alphabetic';
    ctx.restore();
}

function drawStar(ctx, cx, cy, spikes, outer, inner) {
    let rot = (Math.PI / 2) * 3;
    const step = Math.PI / spikes;
    ctx.beginPath();
    ctx.moveTo(cx, cy - outer);
    for (let i = 0; i < spikes; i++) {
        ctx.lineTo(cx + Math.cos(rot) * outer, cy + Math.sin(rot) * outer);
        rot += step;
        ctx.lineTo(cx + Math.cos(rot) * inner, cy + Math.sin(rot) * inner);
        rot += step;
    }
    ctx.lineTo(cx, cy - outer);
    ctx.closePath();
    ctx.fill();
}

// 帶字距的文字（英文小標）
function spacedText(ctx, text, cx, y, spacing) {
    const chars = [...text];
    const widths = chars.map((c) => ctx.measureText(c).width);
    const total = widths.reduce((s, w) => s + w, 0) + spacing * (chars.length - 1);
    let x = cx - total / 2;
    const prevAlign = ctx.textAlign;
    ctx.textAlign = 'left';
    chars.forEach((c, i) => {
        ctx.fillText(c, x, y);
        x += widths[i] + spacing;
    });
    ctx.textAlign = prevAlign;
}

/**
 * 在 canvas 上完整繪製證書。
 */
function drawCertificate(ctx, { name, dateText, message, serial }) {
    const W = PAGE_W;
    const H = PAGE_H;
    const cx = W / 2;

    // 背景（米白 + 極淡暈影）
    ctx.fillStyle = CREAM;
    ctx.fillRect(0, 0, W, H);
    const vg = ctx.createRadialGradient(cx, H / 2, 120, cx, H / 2, 560);
    vg.addColorStop(0, 'rgba(255,255,255,0)');
    vg.addColorStop(1, 'rgba(193,154,62,0.06)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    // 浮水印底紋
    watermark(ctx, cx, H / 2);

    // 外框：navy 粗框 + gold 內細框
    ctx.strokeStyle = NAVY;
    ctx.lineWidth = 5;
    ctx.strokeRect(26, 26, W - 52, H - 52);
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.4;
    ctx.strokeRect(38, 38, W - 76, H - 76);

    // 四角裝飾
    cornerOrnament(ctx, 50, 50, 1, 1);
    cornerOrnament(ctx, W - 50, 50, -1, 1);
    cornerOrnament(ctx, 50, H - 50, 1, -1);
    cornerOrnament(ctx, W - 50, H - 50, -1, -1);

    ctx.textAlign = 'center';

    // 頂部英文小標（字距）
    ctx.fillStyle = GOLD;
    ctx.font = `600 15px ${FONT_FAMILY}`;
    spacedText(ctx, 'CERTIFICATE OF COMPLETION', cx, 88, 6);

    // 主標題
    ctx.fillStyle = NAVY;
    ctx.font = `800 44px ${FONT_FAMILY}`;
    ctx.fillText('完 成 證 明', cx, 146);

    // 課程名（副標）
    ctx.fillStyle = '#334155';
    ctx.font = `600 21px ${FONT_FAMILY}`;
    ctx.fillText('夢想一號魔術方塊師資培訓', cx, 184);

    // 金線分隔
    goldDivider(ctx, cx, 208, 90);

    // 「茲證明」
    ctx.fillStyle = MUTE;
    ctx.font = `500 17px ${FONT_FAMILY}`;
    spacedText(ctx, '茲證明', cx, 262, 8);

    // 講師姓名（最醒目）
    ctx.fillStyle = NAVY_DEEP;
    ctx.font = `800 48px ${FONT_FAMILY}`;
    ctx.fillText(name || '講師', cx, 318);

    // 姓名底線（兩端小菱形）
    const nameW = Math.min(420, Math.max(200, ctx.measureText(name || '講師').width + 90));
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx - nameW / 2, 340);
    ctx.lineTo(cx + nameW / 2, 340);
    ctx.stroke();
    [-1, 1].forEach((s) => {
        ctx.fillStyle = GOLD;
        ctx.save();
        ctx.translate(cx + (s * nameW) / 2, 340);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-3, -3, 6, 6);
        ctx.restore();
    });

    // 正文
    ctx.fillStyle = INK;
    ctx.font = `500 17px ${FONT_FAMILY}`;
    ctx.fillText('已完成本培訓課程之所有章節與考核，表現優異，特頒此證，以資鼓勵。', cx, 384);

    // 祝賀語
    ctx.fillStyle = NAVY;
    ctx.font = `600 16px ${FONT_FAMILY}`;
    ctx.fillText(message || '恭喜你完成培訓，成為夢想一號的正式講師！', cx, 418);

    // 底部：日期（左）與簽署方（右），中央留給印璽
    ctx.textAlign = 'center';
    // 發證日期（偏左）
    const dateX = 210;
    ctx.fillStyle = NAVY_DEEP;
    ctx.font = `600 17px ${FONT_FAMILY}`;
    ctx.fillText(dateText, dateX, 500);
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(dateX - 90, 512);
    ctx.lineTo(dateX + 90, 512);
    ctx.stroke();
    ctx.fillStyle = MUTE;
    ctx.font = `500 13px ${FONT_FAMILY}`;
    ctx.fillText('發證日期', dateX, 532);

    // 簽署方（偏右）
    const signX = W - 210;
    ctx.fillStyle = NAVY_DEEP;
    ctx.font = `700 16px ${FONT_FAMILY}`;
    ctx.fillText('夢想一號文化教育', signX, 498);
    ctx.fillText('股份有限公司', signX, 518);
    ctx.strokeStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.moveTo(signX - 90, 512 + 18);
    ctx.lineTo(signX + 90, 512 + 18);
    ctx.stroke();
    ctx.fillStyle = MUTE;
    ctx.font = `500 13px ${FONT_FAMILY}`;
    ctx.fillText('授權簽署', signX, 549);

    // 中央印璽
    drawSeal(ctx, cx, 500, 46);

    // 證書編號（左下角）
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTE;
    ctx.font = `500 12px ${FONT_FAMILY}`;
    ctx.fillText(`證書編號   ${serial}`, 62, H - 44);
    ctx.textAlign = 'center';
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
    const dt = date instanceof Date ? date : new Date(date || Date.now());
    const canvas = document.createElement('canvas');
    canvas.width = PAGE_W * DPR;
    canvas.height = PAGE_H * DPR;
    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);
    drawCertificate(ctx, {
        name,
        dateText: formatDate(dt),
        message,
        serial: certificateNo(name, dt),
    });

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
