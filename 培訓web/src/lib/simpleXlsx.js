// 最小可用的 .xlsx 產生器（2026-10-22 月結匯款匯出用；專案沒有 xlsx 函式庫、也不新增套件，只用已有的 jszip）。
// 只做匯出需要的事：多個分頁、文字儲存格、數字儲存格、欄寬、粗體表頭。
// 規則：字串一律寫成 inline string＋文字格式「@」（numFmtId 49），Excel／Google 試算表／Numbers 打開都不會
// 把 0081832 這類代碼吃掉開頭的 0；數字寫成數值儲存格（可加總）；null／undefined／'' 不寫儲存格。
import JSZip from 'jszip';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// cellXfs 的順序（styles.xml）
export const XLSX_STYLE = { default: 0, text: 1, integer: 2, amount: 3, header: 4 };

// XML 1.0 不允許的控制字元直接拿掉；& < > " 轉義
const escapeXml = (value) => String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const columnName = (index) => {
    let n = index + 1;
    let name = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        name = String.fromCharCode(65 + rem) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
};

// Excel 分頁名稱限制：≤31 字、不可含 : \ / ? * [ ]
const assertSheetName = (name) => {
    if (!name || name.length > 31 || /[:\\/?*[\]]/.test(name)) throw new Error(`分頁名稱不合法：${name}`);
};

const cellXml = (ref, value, { numberStyle, isHeader }) => {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`儲存格 ${ref} 不是有效數字`);
        return `<c r="${ref}" s="${numberStyle}"><v>${value}</v></c>`;
    }
    const style = isHeader ? XLSX_STYLE.header : XLSX_STYLE.text;
    return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
};

const sheetXml = ({ rows, colWidths = [], numberStyle = XLSX_STYLE.amount, headerRows = [] }) => {
    const headerSet = new Set(headerRows);
    const cols = colWidths.length
        ? `<cols>${colWidths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`
        : '';
    const body = rows.map((row, r) => {
        const cells = (row || []).map((value, c) => cellXml(`${columnName(c)}${r + 1}`, value, {
            numberStyle, isHeader: headerSet.has(r),
        })).join('');
        return cells ? `<row r="${r + 1}">${cells}</row>` : '';
    }).join('');
    return `${XML_HEADER}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">${cols}<sheetData>${body}</sheetData></worksheet>`;
};

const STYLES_XML = `${XML_HEADER}<styleSheet xmlns="${NS_MAIN}">`
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
    + '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="5">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>'
    + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';

// sheets: [{ name, rows: any[][], colWidths?: number[], numberStyle?: number, headerRows?: number[] }]
// 回傳 Uint8Array（瀏覽器包成 Blob 下載；node 測試可直接用 jszip 讀回）
export const buildXlsx = async (sheets) => {
    if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('至少要有一個分頁');
    const names = new Set();
    for (const sheet of sheets) {
        assertSheetName(sheet.name);
        if (names.has(sheet.name)) throw new Error(`分頁名稱重複：${sheet.name}`);
        names.add(sheet.name);
    }

    const zip = new JSZip();
    zip.file('[Content_Types].xml', `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + '</Types>');
    zip.file('_rels/.rels', `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}">`
        + `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>`
        + '</Relationships>');
    zip.file('xl/workbook.xml', `${XML_HEADER}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>`
        + sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
        + '</sheets></workbook>');
    zip.file('xl/_rels/workbook.xml.rels', `${XML_HEADER}<Relationships xmlns="${NS_PKG_REL}">`
        + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
        + `<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>`
        + '</Relationships>');
    zip.file('xl/styles.xml', STYLES_XML);
    sheets.forEach((sheet, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet)));
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: XLSX_MIME });
};
