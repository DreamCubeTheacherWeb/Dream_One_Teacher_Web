import { PDFDocument } from 'pdf-lib';
import { supabase } from './supabaseClient';

const DPR = 3;

const IMAGE_FIELD_TO_PATH_KEY = {
  photo: 'photo_path',
  id_front_image: 'id_front_path',
  id_back_image: 'id_back_path',
  bankbook_image: 'bankbook_path',
};

const textToPngBuffer = async (text, opts = {}) => {
  const {
    fontSize = 13,
    color = '#000000',
    maxWidth = 300,
    fontWeight = '500',
    lineHeight = 1.4,
  } = opts;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontFamily =
    '-apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif';
  const fontStr = `${fontWeight} ${fontSize * DPR}px ${fontFamily}`;
  ctx.font = fontStr;

  const breakText = (src) => {
    if (!src) return [''];
    const rows = [];
    let row = '';
    for (const ch of src) {
      const next = row + ch;
      if (ctx.measureText(next).width > maxWidth * DPR && row) {
        rows.push(row);
        row = ch;
      } else {
        row = next;
      }
    }
    if (row) rows.push(row);
    return rows;
  };

  const lines = breakText(String(text || ''));
  const padX = 4 * DPR;
  const padY = 2 * DPR;
  const linePx = Math.round(fontSize * lineHeight * DPR);
  const cw = Math.max(...lines.map((l) => ctx.measureText(l).width), 10);
  const width = Math.ceil(Math.min(maxWidth * DPR, cw) + padX * 2);
  const height = Math.ceil(lines.length * linePx + padY * 2);
  canvas.width = width;
  canvas.height = height;
  const ctx2 = canvas.getContext('2d');
  ctx2.clearRect(0, 0, width, height);
  ctx2.font = fontStr;
  ctx2.fillStyle = color;
  ctx2.textBaseline = 'top';
  lines.forEach((line, i) => ctx2.fillText(line, padX, padY + i * linePx));

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('建立文字影像失敗'))),
      'image/png'
    );
  });
  return {
    buffer: await blob.arrayBuffer(),
    widthPt: width / DPR,
    heightPt: height / DPR,
  };
};

// Re-encode a possibly-WebP/HEIC/JPEG storage image into clean PNG/JPEG bytes
// that pdf-lib can definitely embed. We draw into canvas to normalize.
const normalizeImageToBytes = async (blob) => {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('圖片載入失敗'));
      el.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const pngBlob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('圖片轉檔失敗'))), 'image/png')
    );
    return await pngBlob.arrayBuffer();
  } finally {
    URL.revokeObjectURL(url);
  }
};

const buildFieldValueMap = (instructor) => ({
  // 合約欄位（沿用原有命名）
  name: instructor.full_name || '',
  instructor_role: instructor.instructor_role ? `${instructor.instructor_role}級` : '',
  id_number: instructor.id_number || '',
  address: instructor.address || '',
  phone: instructor.phone_mobile || '',

  // 匯款表單欄位
  nickname: instructor.nickname || '',
  email_primary: instructor.email_primary || '',
  bank_account_name: instructor.bank_account_name || '',
  bank_name: instructor.bank_name || '',
  bank_branch: instructor.bank_branch || '',
  bank_account_number: instructor.bank_account_number || '',
  bank_code: instructor.bank_code || '',
});

const fetchInstructorImage = async (path) => {
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from('instructor_uploads')
    .download(path);
  if (error || !data) return null;
  try {
    return await normalizeImageToBytes(data);
  } catch (e) {
    console.warn('Image normalize failed for', path, e);
    return null;
  }
};

/**
 * Generate a filled-in PDF from a contract_documents template and an
 * instructors row. Returns Uint8Array of the produced PDF.
 *
 * @param {Object} opts
 * @param {Object} opts.docMeta     — row from contract_documents (must have file_path, doc_type, version)
 * @param {Array}  opts.positions   — rows from contract_field_positions
 * @param {Object} opts.instructor  — row from instructors
 */
export async function generateFilledForm({ docMeta, positions, instructor }) {
  const { data: fileData, error } = await supabase.storage
    .from('contract-documents')
    .download(docMeta.file_path);
  if (error || !fileData) {
    throw new Error(`無法下載模板：${docMeta.file_path}`);
  }

  const pdfBytes = await fileData.arrayBuffer();
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();

  const fieldValueMap = buildFieldValueMap(instructor);
  const imageCache = {};

  for (const pos of positions || []) {
    const page = pages[pos.page_number - 1];
    if (!page) continue;
    const { height: pageH } = page.getSize();

    // ── 圖片欄位 ──
    const imagePathKey = IMAGE_FIELD_TO_PATH_KEY[pos.field_type];
    if (imagePathKey) {
      const path = instructor[imagePathKey];
      if (!path) continue;
      if (!imageCache[path]) {
        imageCache[path] = await fetchInstructorImage(path);
      }
      const imageBytes = imageCache[path];
      if (!imageBytes) continue;

      let embedded;
      try {
        embedded = await pdfDoc.embedPng(imageBytes);
      } catch {
        try {
          embedded = await pdfDoc.embedJpg(imageBytes);
        } catch (e2) {
          console.warn(`無法嵌入圖片 ${path}：${e2.message}`);
          continue;
        }
      }
      page.drawImage(embedded, {
        x: pos.x,
        y: pageH - pos.y_from_top - pos.height,
        width: pos.width,
        height: pos.height,
      });
      continue;
    }

    // ── 文字欄位 ──
    const text = fieldValueMap[pos.field_type];
    if (!text) continue;
    const { buffer, widthPt, heightPt } = await textToPngBuffer(text, {
      fontSize: pos.font_size || 13,
      maxWidth: pos.width,
      color: '#000000',
    });
    const png = await pdfDoc.embedPng(buffer);
    page.drawImage(png, {
      x: pos.x,
      y: pageH - pos.y_from_top - heightPt,
      width: widthPt,
      height: heightPt,
    });
  }

  return pdfDoc.save();
}

/**
 * Load the active template + positions for a given doc_type.
 * Returns { docMeta, positions } or throws if template missing.
 */
export async function loadFormTemplate(docType) {
  const { data: docs, error: docErr } = await supabase
    .from('contract_documents')
    .select('*')
    .eq('doc_type', docType)
    .eq('is_active', true)
    .order('version', { ascending: false })
    .limit(1);

  if (docErr) throw new Error(`查模板失敗：${docErr.message}`);
  if (!docs?.length) throw new Error(`找不到啟用中的模板：${docType}`);
  const docMeta = docs[0];

  const { data: positions, error: posErr } = await supabase
    .from('contract_field_positions')
    .select('*')
    .eq('doc_type', docType)
    .eq('doc_version', docMeta.version);
  if (posErr) throw new Error(`查欄位定位失敗：${posErr.message}`);

  return { docMeta, positions: positions || [] };
}

/**
 * High-level convenience: takes a doc_type and instructor user_id,
 * returns the filled PDF bytes plus a suggested filename.
 */
export async function generateFormForInstructor({ docType, userId }) {
  const { docMeta, positions } = await loadFormTemplate(docType);

  const { data: instructor, error: instErr } = await supabase
    .from('instructors')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (instErr) throw new Error(`查講師資料失敗：${instErr.message}`);
  if (!instructor) throw new Error(`找不到講師資料：${userId}`);

  const bytes = await generateFilledForm({ docMeta, positions, instructor });
  const safeName = (instructor.full_name || 'unknown').replace(/[/\\?%*:|"<>]/g, '_');
  const filename = `${safeName}-${docMeta.display_name || docType}.pdf`;

  return { bytes, filename, instructor };
}
