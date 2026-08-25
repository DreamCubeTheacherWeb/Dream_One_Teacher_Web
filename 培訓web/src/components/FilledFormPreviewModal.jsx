import { useEffect, useRef } from 'react';
import { Download, ExternalLink, FileText, X } from 'lucide-react';
import DocumentViewer from './DocumentViewer';

const FilledFormPreviewModal = ({ preview, onClose, onDownload }) => {
  const closeButtonRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!preview) return undefined;

    const previousActiveElement = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;

      const focusableElements = dialogRef.current?.querySelectorAll(
        'a[href], button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusableElements?.length) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousActiveElement?.focus?.();
    };
  }, [onClose, preview]);

  if (!preview) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-bauhaus-black/60 p-2 sm:p-4 flex items-center justify-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="filled-form-preview-title"
        aria-describedby="filled-form-preview-description"
        className="w-full max-w-6xl h-[calc(100dvh-1rem)] sm:h-[calc(100dvh-2rem)] bg-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard-lg overflow-hidden flex flex-col"
      >
        <header className="shrink-0 bg-bauhaus-black text-white px-4 py-3 sm:px-5 sm:py-4 flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg border-2 border-white bg-bauhaus-blue flex items-center justify-center shrink-0">
            <FileText className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 id="filled-form-preview-title" className="text-lg sm:text-xl font-black leading-tight">
              表單預覽
            </h2>
            <p className="text-sm text-white/75 mt-1 truncate" title={preview.filename}>
              {preview.filename}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="min-w-[44px] min-h-[44px] rounded-xl border-2 border-white/60 hover:border-white hover:bg-white hover:text-bauhaus-black flex items-center justify-center transition-colors"
            aria-label="關閉表單預覽"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto bg-bauhaus-paper p-3 sm:p-5">
          <div className="max-w-4xl mx-auto">
            <p id="filled-form-preview-description" className="mb-4 text-sm font-bold text-bauhaus-black/65">
              請確認自動帶入的資料與附件內容，確認後再下載 PDF。
            </p>
            <DocumentViewer fileUrl={preview.url} />
          </div>
        </div>

        <footer className="shrink-0 border-t-2 lg:border-t-4 border-bauhaus-black bg-white p-3 sm:p-4 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
          <a
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
            className="bh-btn bh-btn-outline px-4 py-2.5 text-sm justify-center"
          >
            <ExternalLink className="w-4 h-4" /> 在新分頁開啟
          </a>
          <button type="button" onClick={onClose} className="bh-btn bh-btn-outline px-4 py-2.5 text-sm justify-center">
            關閉
          </button>
          <button type="button" onClick={onDownload} className="bh-btn bh-btn-blue px-5 py-2.5 text-sm justify-center">
            <Download className="w-4 h-4" /> 下載 PDF
          </button>
        </footer>
      </section>
    </div>
  );
};

export default FilledFormPreviewModal;
