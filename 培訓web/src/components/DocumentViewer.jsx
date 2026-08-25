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

const DocumentViewer = ({ fileUrl, fileData, onFinishReading, finishButtonText = '我已完整看完且清楚這份文件的所有內容' }) => {
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
  // 動態產生的表單直接交給 PDF.js bytes，避免正式站 CSP 阻擋 blob: URL 的 fetch。
  // 一般已上傳文件仍沿用既有 URL 載入流程。
  const pdfSource = useMemo(() => (
    fileData ? { data: fileData } : fileUrl
  ), [fileData, fileUrl]);

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

  if (!pdfSource) {
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
          onClick={() => setZoomPage(currentPage)}
        >
          <Document file={pdfSource} onLoadSuccess={onDocumentLoadSuccess} loading={
            <div className="flex items-center justify-center h-[500px] w-full">
              <div className="animate-spin w-8 h-8 border-4 border-bauhaus-black border-t-transparent rounded-full" />
            </div>
          }>
            <Page
              pageNumber={currentPage}
              width={pageWidth}
              renderTextLayer={true}
              renderAnnotationLayer={true}
              onRenderSuccess={onPageRenderSuccess}
            />
          </Document>

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
              <Document file={pdfSource}>
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
