import { useState, useCallback, useEffect, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { ChevronLeft, ChevronRight, ZoomIn, X, Maximize2 } from 'lucide-react';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const DocumentViewer = ({ fileUrl, onFinishReading, finishButtonText = '我已完整看完且清楚這份文件的所有內容' }) => {
  const [numPages, setNumPages] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasReachedEnd, setHasReachedEnd] = useState(false);
  const [zoomPage, setZoomPage] = useState(null);
  const [pageWidth, setPageWidth] = useState(600);
  const containerRef = useRef(null);

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

  const goToPage = (page) => {
    if (page < 1 || page > numPages) return;
    setCurrentPage(page);
    if (page === numPages) setHasReachedEnd(true);
  };

  if (!fileUrl) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400">
        尚未上傳文件
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col items-center w-full">
      {/* Progress bar */}
      <div className="w-full mb-4">
        <div className="flex items-center justify-between text-sm text-slate-500 mb-1.5">
          <span>閱讀進度</span>
          <span className="font-mono">{currentPage} / {numPages || '...'}</span>
        </div>
        <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 rounded-full transition-all duration-500 ease-out"
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
          className="absolute left-0 z-10 p-3 md:p-2 rounded-full bg-white/90 shadow-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
        >
          <ChevronLeft className="w-5 h-5 text-slate-600" />
        </button>

        {/* Page container with peek effect */}
        <div className="relative overflow-hidden rounded-xl shadow-lg border border-slate-200 bg-white cursor-pointer group"
          onClick={() => setZoomPage(currentPage)}
        >
          <Document file={fileUrl} onLoadSuccess={onDocumentLoadSuccess} loading={
            <div className="flex items-center justify-center h-[500px] w-full">
              <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
            </div>
          }>
            <Page
              pageNumber={currentPage}
              width={pageWidth}
              renderTextLayer={true}
              renderAnnotationLayer={true}
            />
          </Document>

          {/* Zoom hint overlay */}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
            <div className="bg-white/90 rounded-full p-3 shadow-lg">
              <Maximize2 className="w-5 h-5 text-slate-600" />
            </div>
          </div>
        </div>

        {/* Right arrow */}
        <button
          onClick={() => goToPage(currentPage + 1)}
          disabled={!numPages || currentPage >= numPages}
          className="absolute right-0 z-10 p-3 md:p-2 rounded-full bg-white/90 shadow-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
        >
          <ChevronRight className="w-5 h-5 text-slate-600" />
        </button>
      </div>

      {/* Page dots */}
      {numPages && numPages <= 20 && (
        <div className="flex gap-1.5 mt-4 flex-wrap justify-center">
          {Array.from({ length: numPages }, (_, i) => (
            <button
              key={i}
              onClick={() => goToPage(i + 1)}
              className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${
                currentPage === i + 1
                  ? 'bg-blue-500 scale-125'
                  : i + 1 <= currentPage ? 'bg-blue-300' : 'bg-slate-200 hover:bg-slate-300'
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
          className={`mt-6 w-full md:w-auto max-w-full text-center px-6 py-3 rounded-xl font-bold text-sm transition-all duration-300 ${
            hasReachedEnd
              ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-500/25 hover:shadow-xl hover:shadow-blue-500/30 hover:-translate-y-0.5'
              : 'bg-slate-100 text-slate-400 cursor-not-allowed'
          }`}
        >
          {hasReachedEnd ? finishButtonText : `請閱讀至最後一頁 (${numPages ? `還剩 ${numPages - currentPage} 頁` : '載入中...'})`}
        </button>
      )}

      {/* Zoom Modal */}
      {zoomPage && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setZoomPage(null)}>
          <div className="relative max-w-full max-h-full overflow-auto bg-white rounded-2xl" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setZoomPage(null)}
              className="absolute top-3 right-3 z-10 p-3 md:p-2 bg-white/90 rounded-full shadow-lg hover:bg-slate-100 transition-all"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="p-2 overflow-auto max-h-[90dvh]">
              <Document file={fileUrl}>
                <Page
                  pageNumber={zoomPage}
                  width={Math.min(window.innerWidth - 48, 1200)}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                />
              </Document>
            </div>
            <div className="flex items-center justify-center gap-3 py-3 border-t border-slate-100">
              <button
                onClick={() => setZoomPage(Math.max(1, zoomPage - 1))}
                disabled={zoomPage <= 1}
                className="p-3 md:p-2 rounded-lg hover:bg-slate-100 disabled:opacity-30"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <span className="text-sm font-mono text-slate-500">{zoomPage} / {numPages}</span>
              <button
                onClick={() => setZoomPage(Math.min(numPages, zoomPage + 1))}
                disabled={zoomPage >= numPages}
                className="p-3 md:p-2 rounded-lg hover:bg-slate-100 disabled:opacity-30"
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
