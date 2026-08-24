import { PDFDocument } from 'pdf-lib';
import { supabase } from './supabaseClient';
import { getInstructorDocumentReference } from './profileCompletion';

const DPR = 3;

const IMAGE_FIELD_TO_DOCUMENT = {
  photo: { key: 'photo', required: false },
  id_front_image: { key: 'id_front', required: true },
  id_back_image: { key: 'id_back', required: true },
  bankbook_image: { key: 'bankbook', required: true },
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

const fetchInstructorDocument = async (reference) => {
  if (!reference) return null;

  let blob;
  if (reference.kind === 'storage') {
    const { data, error } = await supabase.storage
      .from('instructor_uploads')
      .download(reference.value);
    if (error || !data) {
      throw new Error(`無法下載已上傳文件：${reference.value}`);
    }
    blob = data;
  } else {
    let response;
    try {
      response = await fetch(reference.fetchUrl, { credentials: 'omit' });
    } catch {
      throw new Error('無法讀取匯入文件，請先將該文件重新上傳至系統後再產生表單。');
    }
    if (!response.ok) {
      throw new Error(`無法讀取匯入文件（HTTP ${response.status}），請先重新上傳後再產生表單。`);
    }
    blob = await response.blob();
  }

  const sourceBytes = await blob.arrayBuffer();
  const signature = new TextDecoder('ascii').decode(sourceBytes.slice(0, 5));
  if (signature === '%PDF-') {
    return { kind: 'pdf', bytes: sourceBytes };
  }

  try {
    return { kind: 'image', bytes: await normalizeImageToBytes(blob) };
  } catch (e) {
    throw new Error(`文件格式無法處理：${e.message}`);
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
    const imageDocument = IMAGE_FIELD_TO_DOCUMENT[pos.field_type];
    if (imageDocument) {
      const reference = getInstructorDocumentReference(instructor, imageDocument.key);
      if (!reference) continue;
      const cacheKey = `${reference.kind}:${reference.value}`;
      if (!imageCache[cacheKey]) {
        try {
          imageCache[cacheKey] = await fetchInstructorDocument(reference);
        } catch (error) {
          if (imageDocument.required) throw error;
          console.warn(`選填圖片無法載入：${reference.value}`, error);
          continue;
        }
      }
      const document = imageCache[cacheKey];
      if (!document) continue;

      if (document.kind === 'pdf') {
        try {
          const [embeddedPage] = await pdfDoc.embedPdf(document.bytes, [0]);
          page.drawPage(embeddedPage, {
            x: pos.x,
            y: pageH - pos.y_from_top - pos.height,
            width: pos.width,
            height: pos.height,
          });
        } catch (error) {
          if (imageDocument.required) {
            throw new Error(`無法嵌入必填 PDF 文件：${reference.value}`);
          }
          console.warn(`無法嵌入選填 PDF ${reference.value}：${error.message}`);
        }
        continue;
      }

      let embedded;
      try {
        embedded = await pdfDoc.embedPng(document.bytes);
      } catch {
        try {
          embedded = await pdfDoc.embedJpg(document.bytes);
        } catch (e2) {
          if (imageDocument.required) {
            throw new Error(`無法嵌入必填文件：${reference.value}`);
          }
          console.warn(`無法嵌入選填圖片 ${reference.value}：${e2.message}`);
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
 * High-level convenience: takes a doc_type and instructor master id,
 * returns the filled PDF bytes plus a suggested filename.
 */
export async function generateFormForInstructor({ docType, instructorId }) {
  const { docMeta, positions } = await loadFormTemplate(docType);

  const { data: instructor, error: instErr } = await supabase
    .from('instructors')
    .select('*')
    .eq('id', instructorId)
    .maybeSingle();
  if (instErr) throw new Error(`查講師資料失敗：${instErr.message}`);
  if (!instructor) throw new Error(`找不到講師資料：${instructorId}`);

  const bytes = await generateFilledForm({ docMeta, positions, instructor });
  const safeName = (instructor.full_name || 'unknown').replace(/[/\\?%*:|"<>]/g, '_');
  const filename = `${safeName}-${docMeta.display_name || docType}.pdf`;

  return { bytes, filename, instructor };
}
