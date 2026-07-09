import { useRef, useEffect, useState, useCallback } from 'react';
import SignaturePadLib from 'signature_pad';
import { Eraser, RotateCcw, Check, X } from 'lucide-react';

const SignaturePadComponent = ({ onConfirm, onCancel, isOpen }) => {
  const canvasRef = useRef(null);
  const padRef = useRef(null);
  const [isEmpty, setIsEmpty] = useState(true);

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const container = canvas.parentElement;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);

    const w = container.clientWidth;
    const h = Math.min(container.clientHeight, 300);

    canvas.width = w * ratio;
    canvas.height = h * ratio;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);

    if (padRef.current) {
      padRef.current.clear();
      setIsEmpty(true);
    }
  }, []);

  useEffect(() => {
    if (!isOpen || !canvasRef.current) return;

    const pad = new SignaturePadLib(canvasRef.current, {
      penColor: '#1a1a2e',
      minWidth: 1.5,
      maxWidth: 3.5,
      throttle: 16,
      velocityFilterWeight: 0.7,
    });

    pad.addEventListener('beginStroke', () => setIsEmpty(false));
    padRef.current = pad;

    const timer = setTimeout(resizeCanvas, 50);
    window.addEventListener('resize', resizeCanvas);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', resizeCanvas);
      pad.off();
    };
  }, [isOpen, resizeCanvas]);

  const handleClear = () => {
    padRef.current?.clear();
    setIsEmpty(true);
  };

  const handleConfirm = () => {
    if (!padRef.current || padRef.current.isEmpty()) return;
    const dataUrl = padRef.current.toDataURL('image/png');
    onConfirm(dataUrl);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-bauhaus-black/70 flex items-center justify-center p-4">
      <div className="bh-card bg-white w-full max-w-2xl shadow-hard-lg overflow-hidden max-h-[90dvh] flex flex-col">
        <div className="overflow-y-auto min-h-0">
          {/* Header */}
          <div className="p-4 md:p-5 border-b-2 border-bauhaus-black flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-bauhaus-black">電子簽名</h3>
              <p className="text-sm text-bauhaus-black/60 mt-0.5">請在下方白色區域簽下您的姓名</p>
            </div>
            <button onClick={onCancel} className="p-3 md:p-2 border-2 border-bauhaus-black rounded-xl hover:bg-bauhaus-muted transition-colors duration-200">
              <X className="w-5 h-5 text-bauhaus-black" />
            </button>
          </div>

          {/* Canvas area */}
          <div className="p-4 md:p-5">
            <div className="relative border-2 border-dashed border-bauhaus-black rounded-xl bg-white overflow-hidden h-[220px] md:h-[280px]">
              <canvas
                ref={canvasRef}
                className="absolute inset-0 cursor-crosshair touch-none"
              />
              {isEmpty && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <p className="text-bauhaus-black/20 text-lg font-medium select-none">在此簽名</p>
                </div>
              )}
              {/* Signature line */}
              <div className="absolute bottom-12 left-8 right-8 border-b-2 border-bauhaus-black/20 pointer-events-none" />
              <div className="absolute bottom-8 left-8 pointer-events-none">
                <span className="text-xs text-bauhaus-black/30">甲方簽名</span>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="px-4 pb-4 md:px-5 md:pb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <button
              onClick={handleClear}
              className="bh-btn bh-btn-outline w-full md:w-auto px-4 py-3 md:py-2.5 text-sm"
            >
              <RotateCcw className="w-4 h-4" />
              清除重簽
            </button>
            <div className="flex gap-3 w-full md:w-auto">
              <button
                onClick={onCancel}
                className="bh-btn bh-btn-outline flex-1 md:flex-none px-5 py-3 md:py-2.5 text-sm"
              >
                返回
              </button>
              <button
                onClick={handleConfirm}
                disabled={isEmpty}
                className="bh-btn bh-btn-blue flex-1 md:flex-none px-6 py-3 md:py-2.5 text-sm"
              >
                <Check className="w-4 h-4" />
                確認簽名
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SignaturePadComponent;
