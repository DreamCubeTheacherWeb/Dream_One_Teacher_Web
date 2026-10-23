import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { ChevronLeft, ChevronRight, ZoomIn, X, Maximize2 } from 'lucide-react';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// 私密合約由同版本、同源 bundle worker 處理，不在執行時信任第三方 CDN 程式碼。
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// 已上傳的文件（fileUrl）先在主執行緒整份下載完，再以 Blob 交給 PDF.js（react-pdf 會自己讀成位元組）。
// 為什麼不讓 PDF.js 直接用網址下載：那樣它的 worker 會「邊下載邊等資料」，文件還沒載完就被拆掉
// （換到下一份文件、進入簽約同意頁、離開頁面）時，PDF.js worker 內部會丟出沒有人接住的
// 「Worker was terminated」。改成下載完才交給 PDF.js 後，worker 收到的是完整位元組、在同一輪就解析完，
// 拆掉時不會停在半路；還在下載時拆掉，就用 AbortController 取消這次下載。
// 動態產生的表單（fileData）本來就是直接交給 PDF.js bytes（避免正式站 CSP 阻擋 blob: URL 的 fetch），維持不變。
const usePdfFile = (fileUrl, fileData) => {
  const requested = useMemo(() => (fileData ? { data: fileData } : fileUrl), [fileData, fileUrl]);
  const downloadUrl = typeof requested === 'string' ? requested : null;
  const [download, setDownload] = useState({ url: null, blob: null, failed: false });

  useEffect(() => {
    if (!downloadUrl) return undefined;
    const controller = new AbortController();
    fetch(downloadUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => setDownload({ url: downloadUrl, blob, failed: false }))
      .catch((error) => {
        // 元件已拆掉或換了文件：這次下載是我們自己取消的，畫面也已不需要它
        if (controller.signal.aborted) return;
        console.error('[DocumentViewer] 文件下載失敗：', error);
        setDownload({ url: downloadUrl, blob: null, failed: true });
      });
    return () => controller.abort();
  }, [downloadUrl]);

  if (!requested) return { status: 'empty', file: null };
  if (!downloadUrl) return { status: 'ready', file: requested };
  if (download.url !== downloadUrl) return { status: 'loading', file: null };
  if (download.failed) return { status: 'error', file: null };
  return { status: 'ready', file: download.blob };
};

const DocumentLoading = () => (
  <div className="flex items-center justify-center h-[500px] w-full">
    <div className="animate-spin w-8 h-8 border-4 border-bauhaus-black border-t-transparent rounded-full" />
  </div>
);

// 每份文件一份閱讀狀態：換文件（fileUrl 不同）就整個重新掛載，
// 「已讀到最後一頁」不會沿用上一份文件，下一份還沒載入前「看完」按鈕不會先亮起來。
const DocumentViewer = (props) => (
  <DocumentViewerBody key={props.fileUrl || (props.fileData ? 'file-data' : 'empty')} {...props} />
);

const DocumentViewerBody = ({ fileUrl, fileData, onFinishReading, finishButtonText = '我已完整看完且清楚這份文件的所有內容' }) => {
  const [numPages, setNumPages] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasReachedEnd, setHasReachedEnd] = useState(false);
  const [zoomPage, setZoomPage] = useState(null);
  const [pageWidth, setPageWidth] = useState(600);
  // 記錄上一頁渲染完成後的實際高度，換頁瞬間（舊頁已拆、新頁未畫完）用來撐住容器，
  // 避免容器高度塌陷把整頁 scrollY 夾回頂端（react-pdf 換 pageNumber 時會有短暫空窗）。
  const [pageHeight, setPageHeight] = useState(null);
  const containerRef = useRef(null);
  const pdfBoxRef = useRef(null);
  const pdf = usePdfFile(fileUrl, fileData);

  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        const w = containerRef.current.clientWidth;
        setPageWidth(Math.min(w - 32, 800));
      }
    };
    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  const onDocumentLoadSuccess = useCallback(({ numPages: n }) => {
    setNumPages(n);
    setCurrentPage(1);
    setHasReachedEnd(n === 1);
  }, []);

  // 每頁渲染完成（含換頁後的新頁）都更新一次高度基準
  const onPageRenderSuccess = useCallback((page) => {
    setPageHeight(page.height);
  }, []);

  const goToPage = (page) => {
    if (page < 1 || page > numPages) return;
    setCurrentPage(page);
    if (page === numPages) setHasReachedEnd(true);
    // 使用者主動翻頁（箭頭或頁碼圓點）：把文件容器頂端捲回視窗內，讓新頁從頭開始讀，
    // 不必等使用者自己往上滑。初始載入（onDocumentLoadSuccess）不會走到這裡，不受影響。
    requestAnimationFrame(() => {
      pdfBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  if (pdf.status === 'empty') {
    return (
      <div className="flex items-center justify-center h-64 text-bauhaus-black/40 font-medium">
        尚未上傳文件
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col items-center w-full">
      {/* Progress bar */}
      <div className="w-full mb-4">
        <div className="flex items-center justify-between text-sm text-bauhaus-black/60 mb-1.5">
          <span>閱讀進度</span>
          <span className="font-mono">{currentPage} / {numPages || '...'}</span>
        </div>
        <div className="w-full bg-bauhaus-muted border-2 border-bauhaus-black rounded-lg h-2 overflow-hidden">
          <div
            className="h-full bg-bauhaus-blue transition-all duration-500 ease-out"
            style={{ width: numPages ? `${(currentPage / numPages) * 100}%` : '0%' }}
          />
        </div>
      </div>

      {/* PDF Display */}
      <div className="relative w-full flex items-center justify-center">
        {/* Left arrow */}
        <button
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage <= 1}
          className="absolute left-0 z-10 p-3 md:p-2 rounded-full bg-white border-2 border-bauhaus-black shadow-hard-sm hover:bg-bauhaus-muted disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200"
        >
          <ChevronLeft className="w-5 h-5 text-bauhaus-black" />
        </button>

        {/* Page container with peek effect */}
        <div
          ref={pdfBoxRef}
          className="relative overflow-hidden border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard bg-white cursor-pointer group"
          style={pageHeight ? { minHeight: pageHeight, scrollMarginTop: 16 } : { scrollMarginTop: 16 }}
          onClick={() => { if (pdf.status === 'ready') setZoomPage(currentPage); }}
        >
          {pdf.status === 'loading' && <DocumentLoading />}
          {pdf.status === 'error' && (
            <div role="alert" className="flex items-center justify-center h-64 w-full px-6 text-center text-sm font-bold text-bauhaus-red">
              文件載入失敗，請重新整理頁面再試一次；仍無法開啟請聯繫管理員。
            </div>
          )}
          {pdf.status === 'ready' && (
            <Document file={pdf.file} onLoadSuccess={onDocumentLoadSuccess} loading={<DocumentLoading />}>
              <Page
                pageNumber={currentPage}
                width={pageWidth}
                renderTextLayer={true}
                renderAnnotationLayer={true}
                onRenderSuccess={onPageRenderSuccess}
              />
            </Document>
          )}

          {/* Zoom hint overlay */}
          <div className="absolute inset-0 bg-bauhaus-black/0 group-hover:bg-bauhaus-black/10 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
            <div className="bg-white border-2 border-bauhaus-black rounded-full p-3 shadow-hard-sm">
              <Maximize2 className="w-5 h-5 text-bauhaus-black" />
            </div>
          </div>
        </div>

        {/* Right arrow */}
        <button
          onClick={() => goToPage(currentPage + 1)}
          disabled={!numPages || currentPage >= numPages}
          className="absolute right-0 z-10 p-3 md:p-2 rounded-full bg-white border-2 border-bauhaus-black shadow-hard-sm hover:bg-bauhaus-muted disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200"
        >
          <ChevronRight className="w-5 h-5 text-bauhaus-black" />
        </button>
      </div>

      {/* Page dots */}
      {numPages && numPages <= 20 && (
        <div className="flex gap-1.5 mt-4 flex-wrap justify-center">
          {Array.from({ length: numPages }, (_, i) => (
            <button
              key={i}
              onClick={() => goToPage(i + 1)}
              className={`w-2.5 h-2.5 rounded-full border border-bauhaus-black transition-all duration-300 ${
                currentPage === i + 1
                  ? 'bg-bauhaus-blue scale-125'
                  : i + 1 <= currentPage ? 'bg-bauhaus-blue/40' : 'bg-white hover:bg-bauhaus-muted'
              }`}
            />
          ))}
        </div>
      )}

      {/* Finish reading button */}
      {onFinishReading && (
        <button
          onClick={onFinishReading}
          disabled={!hasReachedEnd}
          className="bh-btn bh-btn-blue mt-6 w-full md:w-auto max-w-full px-6 py-3 text-sm"
        >
          {hasReachedEnd ? finishButtonText : `請閱讀至最後一頁 (${numPages ? `還剩 ${numPages - currentPage} 頁` : '載入中...'})`}
        </button>
      )}

      {/* Zoom Modal */}
      {zoomPage && (
        <div className="fixed inset-0 z-50 bg-bauhaus-black/80 flex items-center justify-center p-4" onClick={() => setZoomPage(null)}>
          <div className="relative max-w-full max-h-full overflow-auto bg-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard-lg" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setZoomPage(null)}
              className="absolute top-3 right-3 z-10 p-3 md:p-2 bg-white border-2 border-bauhaus-black rounded-full shadow-hard-sm hover:bg-bauhaus-muted transition-all duration-200"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="p-2 overflow-auto max-h-[90dvh]">
              <Document file={pdf.file}>
                <Page
                  pageNumber={zoomPage}
                  width={Math.min(window.innerWidth - 48, 1200)}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                />
              </Document>
            </div>
            <div className="flex items-center justify-center gap-3 py-3 border-t-2 border-bauhaus-black">
              <button
                onClick={() => setZoomPage(Math.max(1, zoomPage - 1))}
                disabled={zoomPage <= 1}
                className="p-3 md:p-2 border-2 border-bauhaus-black rounded-xl hover:bg-bauhaus-muted disabled:opacity-30 transition-colors duration-200"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <span className="text-sm font-mono text-bauhaus-black/60">{zoomPage} / {numPages}</span>
              <button
                onClick={() => setZoomPage(Math.min(numPages, zoomPage + 1))}
                disabled={zoomPage >= numPages}
                className="p-3 md:p-2 border-2 border-bauhaus-black rounded-xl hover:bg-bauhaus-muted disabled:opacity-30 transition-colors duration-200"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DocumentViewer;
