import { supabase } from './supabaseClient';

const BUCKET = 'contract-documents';

/**
 * 下載 contract-documents 內的檔案：向 Storage 要一條短效連結（Content-Disposition: attachment），
 * 用 <a> 觸發瀏覽器下載。不把檔案先載進記憶體，也不開新分頁。
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export const downloadContractFile = async (path, filename) => {
  if (!path) return { ok: false, error: '找不到檔案路徑' };
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, 120, { download: filename || true });
  if (error || !data?.signedUrl) return { ok: false, error: error?.message || '無法取得下載連結' };
  const anchor = document.createElement('a');
  anchor.href = data.signedUrl;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  return { ok: true };
};

/** 下載檔案的原始位元組（用來算雜湊、驗證完整性）。 */
export const fetchContractFileBytes = async (path) => {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(error?.message || `無法下載 ${path}`);
  return data.arrayBuffer();
};
