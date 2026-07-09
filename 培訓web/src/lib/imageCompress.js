// 徽章圖示上傳前壓縮：把最長邊縮到 maxSize 內，輸出 PNG（保留透明背景）。
// 用 canvas 做等比縮放，不外部依賴。失敗（非圖片、canvas 出錯）時 reject。

/**
 * @param {File|Blob} file 原始圖片檔
 * @param {number} maxSize 最長邊上限（px），預設 256
 * @returns {Promise<Blob>} 壓縮後的 PNG Blob
 */
export function compressImage(file, maxSize = 256) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type?.startsWith('image/')) {
            reject(new Error('請選擇圖片檔案'));
            return;
        }
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            try {
                const { width, height } = img;
                const scale = Math.min(1, maxSize / Math.max(width, height));
                const outW = Math.max(1, Math.round(width * scale));
                const outH = Math.max(1, Math.round(height * scale));

                const canvas = document.createElement('canvas');
                canvas.width = outW;
                canvas.height = outH;
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('無法建立畫布');
                ctx.clearRect(0, 0, outW, outH);
                ctx.drawImage(img, 0, 0, outW, outH);

                canvas.toBlob((blob) => {
                    URL.revokeObjectURL(url);
                    if (!blob) { reject(new Error('圖片壓縮失敗')); return; }
                    resolve(blob);
                }, 'image/png');
            } catch (err) {
                URL.revokeObjectURL(url);
                reject(err);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('圖片讀取失敗'));
        };
        img.src = url;
    });
}
