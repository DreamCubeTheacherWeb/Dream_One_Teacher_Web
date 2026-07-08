import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import ReactQuill, { Quill } from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import { Save, ChevronLeft, Plus, Trash2, FileText, Video, Edit3, GripVertical, ImagePlus, X, Link2, LayoutGrid, List } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';
import CanvasEditor from './CanvasEditor';

// ─── 擴展 Quill Image blot：支援 width / style 以實現自由縮放 ────────────
const BaseImage = Quill.import('formats/image');
class ResizableImage extends BaseImage {
    static create(value) {
        const node = super.create(typeof value === 'string' ? value : value);
        return node;
    }
    static formats(domNode) {
        const formats = {};
        if (domNode.hasAttribute('width')) formats.width = domNode.getAttribute('width');
        if (domNode.style?.width) formats.width = domNode.style.width;
        if (domNode.style?.float) formats.float = domNode.style.float;
        if (domNode.style?.margin) formats.margin = domNode.style.margin;
        return formats;
    }
    format(name, value) {
        if (name === 'width') {
            if (value) { this.domNode.style.width = value; this.domNode.removeAttribute('width'); }
            else { this.domNode.style.width = ''; }
        } else if (name === 'float') {
            this.domNode.style.float = value || '';
            this.domNode.style.margin = value === 'left' ? '0 1em 0.5em 0' : value === 'right' ? '0 0 0.5em 1em' : '';
        } else {
            super.format(name, value);
        }
    }
}
ResizableImage.blotName = 'image';
ResizableImage.tagName = 'IMG';
Quill.register(ResizableImage, true);

// ─── Quill toolbar 設定 ──────────────────────────────────────────────────
const TOOLBAR_OPTIONS = [
    [{ header: [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    ['blockquote', 'code-block'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    [{ indent: '-1' }, { indent: '+1' }],
    [{ color: [] }, { background: [] }],
    [{ align: [] }],
    ['link', 'image', 'video'],
    ['clean'],
];

const QUILL_MODULES = { toolbar: TOOLBAR_OPTIONS };

// ─── YouTube URL → embed URL 轉換 ──────────────────────────────────────────
const toEmbedUrl = (url) => {
    if (!url) return '';
    try {
        const u = new URL(url);
        // 已經是 embed 格式
        if (u.pathname.startsWith('/embed/')) return url;
        // https://www.youtube.com/watch?v=VIDEO_ID
        if ((u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') && u.searchParams.get('v')) {
            return `https://www.youtube.com/embed/${u.searchParams.get('v')}`;
        }
        // https://youtu.be/VIDEO_ID
        if (u.hostname === 'youtu.be' && u.pathname.length > 1) {
            return `https://www.youtube.com/embed${u.pathname}`;
        }
        // https://www.youtube.com/shorts/VIDEO_ID
        if (u.pathname.startsWith('/shorts/')) {
            return `https://www.youtube.com/embed/${u.pathname.replace('/shorts/', '')}`;
        }
    } catch {
        // 不是合法 URL，原封回傳
    }
    return url;
};

const getContentImageUrl = (path) => {
    if (!path) return null;
    const { data } = supabase.storage.from('content-images').getPublicUrl(path);
    return data?.publicUrl;
};

// ─── Main Component ────────────────────────────────────────────────────────
const EditorComponent = ({ lessonId, onBack }) => {
    const [editorMode, setEditorMode] = useState(null); // 'canvas' | 'classic' | null (detecting)
    const [lessonTitle, setLessonTitle] = useState('');
    const [blocks, setBlocks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const imageInputRefs = useRef({});
    const [imageUploading, setImageUploading] = useState({});
    const [activeImage, setActiveImage] = useState(null);
    const imageHandlerRef = useRef();

    // ── 自訂圖片上傳 handler（上傳到 Supabase Storage，非 base64）──
    imageHandlerRef.current = function () {
        const quill = this.quill;
        const input = document.createElement('input');
        input.setAttribute('type', 'file');
        input.setAttribute('accept', 'image/*');
        input.click();
        input.onchange = async () => {
            const file = input.files[0];
            if (!file) return;
            if (!file.type.startsWith('image/')) { alert('僅接受圖片檔案'); return; }
            if (file.size > 10 * 1024 * 1024) { alert('檔案大小不可超過 10MB'); return; }

            const ext = file.name.split('.').pop();
            const path = `content/${lessonId}/${crypto.randomUUID()}.${ext}`;
            const { error } = await supabase.storage.from('content-images').upload(path, file);
            if (error) { alert('圖片上傳失敗：' + error.message); return; }

            const url = supabase.storage.from('content-images').getPublicUrl(path).data?.publicUrl;
            if (url) {
                const range = quill.getSelection(true);
                quill.insertEmbed(range.index, 'image', url, 'user');
                quill.setSelection(range.index + 1);
            }
        };
    };

    const quillModules = useMemo(() => ({
        toolbar: {
            container: TOOLBAR_OPTIONS,
            handlers: {
                image: function () { imageHandlerRef.current?.call(this); },
            },
        },
    }), []);

    // ── 點擊圖片時顯示大小工具列 ──
    const handleEditorClick = useCallback((e) => {
        if (e.target.tagName === 'IMG' && e.target.closest('.ql-editor')) {
            e.stopPropagation();
            const rect = e.target.getBoundingClientRect();
            setActiveImage({ element: e.target, rect });
        }
    }, []);

    const applyImageSize = useCallback((widthValue, floatValue) => {
        if (!activeImage?.element) return;
        const blot = Quill.find(activeImage.element);
        if (blot) {
            blot.format('width', widthValue);
            blot.format('float', floatValue || '');
        } else {
            activeImage.element.style.width = widthValue;
        }
        setActiveImage(null);
    }, [activeImage]);

    useEffect(() => {
        if (!activeImage) return;
        const close = (e) => {
            if (!e.target.closest('.image-size-toolbar') && e.target.tagName !== 'IMG') {
                setActiveImage(null);
            }
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [activeImage]);

    // ── Fetch all content blocks ──
    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                const { data: lesson } = await supabase
                    .from('lessons')
                    .select('title')
                    .eq('id', lessonId)
                    .single();
                if (lesson) setLessonTitle(lesson.title);

                const { data: contents } = await supabase
                    .from('contents')
                    .select('*')
                    .eq('lesson_id', lessonId)
                    .order('order', { ascending: true });

                const hasCanvasData = (contents || []).some(c => c.position_data != null);
                if (editorMode === null) {
                    setEditorMode(hasCanvasData ? 'canvas' : 'classic');
                }

                const processed = (contents || []).map(b => {
                    if (b.type === 'image_text') {
                        try {
                            const parsed = JSON.parse(b.body || '{}');
                            return { ...b, caption: parsed.caption || '', captionLink: parsed.captionLink || '' };
                        } catch { return { ...b, caption: '', captionLink: '' }; }
                    }
                    return b;
                });
                setBlocks(processed);
            } catch (err) {
                console.error('fetch error:', err);
            } finally {
                setLoading(false);
            }
        };
        if (lessonId) fetchData();
    }, [lessonId]);

    // ── Update a block's field ──
    const updateBlock = (id, field, value) => {
        setBlocks(prev => prev.map(b => b.id === id ? { ...b, [field]: value } : b));
    };

    // ── Add article block ──
    const addArticleBlock = () => {
        const newOrder = blocks.length > 0 ? Math.max(...blocks.map(b => b.order ?? 0)) + 1 : 0;
        const tempId = `new_${Date.now()}`;
        const newBlock = { id: tempId, type: 'article', title: '文字區塊', body: '', order: newOrder, isNew: true };
        setBlocks(prev => [...prev, newBlock]);
    };

    // ── Add video block ──
    const addVideoBlock = () => {
        const newOrder = blocks.length > 0 ? Math.max(...blocks.map(b => b.order ?? 0)) + 1 : 0;
        const tempId = `new_${Date.now()}`;
        const newBlock = { id: tempId, type: 'video', title: '影片區塊', video_url: '', body: '', order: newOrder, isNew: true };
        setBlocks(prev => [...prev, newBlock]);
    };

    // ── Add image_text block ──
    const addImageTextBlock = () => {
        const newOrder = blocks.length > 0 ? Math.max(...blocks.map(b => b.order ?? 0)) + 1 : 0;
        const tempId = `new_${Date.now()}`;
        const newBlock = {
            id: tempId, type: 'image_text', title: '圖文區塊',
            video_url: '', body: '', caption: '', captionLink: '',
            order: newOrder, isNew: true,
        };
        setBlocks(prev => [...prev, newBlock]);
    };

    // ── Upload image for image_text block ──
    const handleContentImageUpload = async (blockId, file) => {
        if (!file.type.startsWith('image/')) {
            alert('僅接受圖片檔案（JPEG、PNG、GIF、WebP）');
            return;
        }
        if (file.size > 10 * 1024 * 1024) {
            alert('檔案大小不可超過 10MB');
            return;
        }
        setImageUploading(prev => ({ ...prev, [blockId]: true }));

        const block = blocks.find(b => b.id === blockId);
        if (block?.video_url) {
            await supabase.storage.from('content-images').remove([block.video_url]);
        }

        const ext = file.name.split('.').pop();
        const path = `content/${lessonId}/${crypto.randomUUID()}.${ext}`;

        const { error } = await supabase.storage
            .from('content-images')
            .upload(path, file);

        if (error) {
            alert('圖片上傳失敗：' + error.message);
            setImageUploading(prev => ({ ...prev, [blockId]: false }));
            return;
        }
        updateBlock(blockId, 'video_url', path);
        setImageUploading(prev => ({ ...prev, [blockId]: false }));
    };

    const handleRemoveContentImage = async (blockId) => {
        const block = blocks.find(b => b.id === blockId);
        if (block?.video_url) {
            await supabase.storage.from('content-images').remove([block.video_url]);
        }
        updateBlock(blockId, 'video_url', '');
    };

    // ── Save all blocks ──
    const handleSaveAll = async () => {
        setSaving(true);

        try {
            const newBlocks = blocks.filter(b => b.isNew);
            const existingBlocks = blocks.filter(b => !b.isNew);

            for (const b of newBlocks) {
                const payload = {
                    lesson_id: lessonId,
                    type: b.type === 'text' ? 'article' : b.type,
                    title: b.title || '',
                    body: b.type === 'image_text'
                        ? JSON.stringify({ caption: b.caption || '', captionLink: b.captionLink || '' })
                        : (b.body || ''),
                    video_url: b.video_url || null,
                    order: b.order,
                    status: 'draft',
                };

                const { error } = await supabase
                    .from('contents')
                    .insert(payload);

                if (error) throw error;
            }

            for (const b of existingBlocks) {
                const payload = {
                    type: b.type === 'text' ? 'article' : b.type,
                    title: b.title || '',
                    body: b.type === 'image_text'
                        ? JSON.stringify({ caption: b.caption || '', captionLink: b.captionLink || '' })
                        : (b.body || ''),
                    video_url: b.video_url || null,
                    order: b.order,
                };

                const { error } = await supabase
                    .from('contents')
                    .update(payload)
                    .eq('id', b.id);

                if (error) throw error;
            }

            // 儲存成功後重新從資料庫載入最新資料
            const { data: refreshed } = await supabase
                .from('contents')
                .select('*')
                .eq('lesson_id', lessonId)
                .order('order', { ascending: true });

            const processedRefresh = (refreshed || []).map(b => {
                if (b.type === 'image_text') {
                    try {
                        const parsed = JSON.parse(b.body || '{}');
                        return { ...b, caption: parsed.caption || '', captionLink: parsed.captionLink || '' };
                    } catch { return { ...b, caption: '', captionLink: '' }; }
                }
                return b;
            });
            setBlocks(processedRefresh);
            alert('所有內容已儲存成功！');
        } catch (err) {
            console.error('儲存失敗:', err);
            alert('儲存失敗：' + (err?.message || JSON.stringify(err)));
        } finally {
            setSaving(false);
        }
    };

    // ── Delete block ──
    const handleDelete = async (blockId, isNew) => {
        if (!window.confirm('確定要刪除此區塊嗎？')) return;

        const block = blocks.find(b => b.id === blockId);
        if (block?.type === 'image_text' && block.video_url) {
            await supabase.storage.from('content-images').remove([block.video_url]);
        }

        if (!isNew) {
            const { error } = await supabase.from('contents').delete().eq('id', blockId);
            if (error) {
                alert('刪除失敗：' + error.message);
                return;
            }
        }
        setBlocks(prev => prev.filter(b => b.id !== blockId));
    };

    if (loading) return <div className="p-12 text-center text-slate-500 font-bold">載入課程內容中...</div>;

    if (editorMode === 'canvas') {
        return <CanvasEditor lessonId={lessonId} onBack={onBack} onSwitchToClassic={() => setEditorMode('classic')} />;
    }

    return (
        <div className="flex flex-col h-[calc(100vh-64px)] bg-slate-50 overflow-hidden">
            {/* ── Top bar ── */}
            <div className="bg-white border-b border-slate-200 flex items-center justify-between px-6 py-4 sticky top-0 z-20 shadow-sm">
                <div className="flex items-center gap-4">
                    <button
                        onClick={onBack}
                        className="p-2 hover:bg-slate-100 rounded-xl text-slate-500 transition-all active:scale-95"
                    >
                        <ChevronLeft className="w-6 h-6" />
                    </button>
                    <div>
                        <div className="text-[10px] font-black text-blue-600 uppercase tracking-widest mb-0.5">CMS 編輯模式</div>
                        <div className="font-black text-slate-900 text-xl leading-tight">{lessonTitle}</div>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <button
                        onClick={() => setEditorMode('canvas')}
                        className="flex items-center gap-2 bg-violet-50 border border-violet-200 text-violet-700 px-4 py-2 rounded-xl hover:bg-violet-100 transition-all font-bold text-sm shadow-sm active:scale-95"
                        title="切換到畫布自由排版模式"
                    >
                        <LayoutGrid className="w-4 h-4" /> 畫布模式
                    </button>
                    <div className="w-px h-6 bg-slate-200 mx-1" />
                    <button
                        onClick={addArticleBlock}
                        className="flex items-center gap-2 bg-white border border-slate-200 text-slate-700 px-4 py-2 rounded-xl hover:border-blue-500 hover:text-blue-600 transition-all font-bold text-sm shadow-sm active:scale-95"
                    >
                        <Plus className="w-4 h-4" /> 新增文字
                    </button>
                    <button
                        onClick={addVideoBlock}
                        className="flex items-center gap-2 bg-white border border-slate-200 text-slate-700 px-4 py-2 rounded-xl hover:border-purple-500 hover:text-purple-600 transition-all font-bold text-sm shadow-sm active:scale-95"
                    >
                        <Plus className="w-4 h-4" /> 新增影片
                    </button>
                    <button
                        onClick={addImageTextBlock}
                        className="flex items-center gap-2 bg-white border border-slate-200 text-slate-700 px-4 py-2 rounded-xl hover:border-emerald-500 hover:text-emerald-600 transition-all font-bold text-sm shadow-sm active:scale-95"
                    >
                        <Plus className="w-4 h-4" /> 新增圖文
                    </button>
                    <div className="w-px h-6 bg-slate-200 mx-1" />
                    <button
                        onClick={handleSaveAll}
                        disabled={saving}
                        className="flex items-center gap-2 bg-blue-600 text-white px-6 py-2 rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-all shadow-lg shadow-blue-500/20 font-black text-sm active:scale-95"
                    >
                        <Save className="w-4 h-4" />
                        {saving ? '儲存中...' : '儲存變更'}
                    </button>
                </div>
            </div>

            {/* ── Content area ── */}
            <div className="flex-1 overflow-y-auto pb-24">
                <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
                    {blocks.length === 0 && (
                        <div className="bg-white rounded-3xl border-2 border-dashed border-slate-200 p-20 text-center">
                            <div className="bg-slate-50 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4">
                                <Edit3 className="w-8 h-8 text-slate-300" />
                            </div>
                            <h3 className="text-slate-900 font-black text-lg mb-2">目前沒有內容</h3>
                            <p className="text-slate-400 text-sm mb-6">點擊上方按鈕開始新增您的教學內容</p>
                            <div className="flex justify-center gap-3">
                                <button onClick={addArticleBlock} className="text-blue-600 font-bold text-sm hover:underline">+ 加入文字內容</button>
                                <span className="text-slate-200">|</span>
                                <button onClick={addVideoBlock} className="text-purple-600 font-bold text-sm hover:underline">+ 加入影音教材</button>
                                <span className="text-slate-200">|</span>
                                <button onClick={addImageTextBlock} className="text-emerald-600 font-bold text-sm hover:underline">+ 加入圖文區塊</button>
                            </div>
                        </div>
                    )}

                    {blocks.map((block, index) => (
                        <div
                            key={block.id}
                            className={`bg-white rounded-3xl border ${block.isNew ? 'border-blue-200 shadow-blue-100/50' : 'border-slate-200'} shadow-sm overflow-hidden group transition-all hover:shadow-md`}
                        >
                            {/* Block Header */}
                            <div className="px-6 py-3 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="flex items-center gap-1.5 grayscale group-hover:grayscale-0 transition-all">
                                        <GripVertical className="w-4 h-4 text-slate-300" />
                                        <span className="text-[10px] font-black text-slate-400 bg-white border border-slate-200 px-2 py-0.5 rounded-full">
                                            #{index + 1} {block.type === 'video' ? 'VIDEO' : block.type === 'image_text' ? 'IMAGE' : 'ARTICLE'}
                                        </span>
                                    </div>
                                    <input
                                        type="text"
                                        value={block.title}
                                        onChange={(e) => updateBlock(block.id, 'title', e.target.value)}
                                        placeholder="請輸入區塊標題..."
                                        className="bg-transparent border-none outline-none font-bold text-slate-700 placeholder:text-slate-300 w-64 focus:ring-0"
                                    />
                                    {block.isNew && <span className="text-[9px] font-black text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded uppercase">NEW</span>}
                                </div>
                                <button
                                    onClick={() => handleDelete(block.id, block.isNew)}
                                    className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>

                            {/* Block Content */}
                            <div className="p-6">
                                {block.type === 'image_text' ? (
                                    <div className="space-y-4">
                                        <div className="border-2 border-dashed border-slate-200 rounded-2xl overflow-hidden hover:border-emerald-300 transition-colors">
                                            {block.video_url ? (
                                                <div className="relative group">
                                                    <img
                                                        src={getContentImageUrl(block.video_url)}
                                                        alt="圖文區塊"
                                                        className="max-h-80 w-full object-contain bg-slate-50 p-2"
                                                    />
                                                    <button
                                                        onClick={() => handleRemoveContentImage(block.id)}
                                                        className="absolute top-2 right-2 bg-red-500 text-white rounded-full p-1.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity hover:bg-red-600 shadow-lg before:absolute before:-inset-2 before:content-['']"
                                                    >
                                                        <X className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            ) : imageUploading[block.id] ? (
                                                <div className="py-16 flex flex-col items-center gap-2 text-emerald-500">
                                                    <div className="w-8 h-8 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                                                    <span className="text-sm font-medium">上傳中⋯</span>
                                                </div>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => imageInputRefs.current[block.id]?.click()}
                                                    className="py-16 w-full flex flex-col items-center gap-3 text-slate-400 hover:text-emerald-500 transition-colors"
                                                >
                                                    <ImagePlus className="w-12 h-12" />
                                                    <span className="text-sm font-bold">點擊上傳圖片</span>
                                                    <span className="text-xs text-slate-300">支援 JPEG、PNG、GIF、WebP，上限 10MB</span>
                                                </button>
                                            )}
                                            <input
                                                ref={el => (imageInputRefs.current[block.id] = el)}
                                                type="file"
                                                accept="image/*"
                                                className="hidden"
                                                onChange={e => {
                                                    if (e.target.files[0]) handleContentImageUpload(block.id, e.target.files[0]);
                                                    e.target.value = '';
                                                }}
                                            />
                                        </div>

                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                            <div className="flex items-center gap-2 bg-slate-50 border border-slate-100 p-3 rounded-xl">
                                                <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                                                <input
                                                    type="text"
                                                    value={block.caption || ''}
                                                    onChange={e => updateBlock(block.id, 'caption', e.target.value)}
                                                    placeholder="圖片說明文字"
                                                    className="flex-1 bg-transparent border-none outline-none text-sm focus:ring-0"
                                                />
                                            </div>
                                            <div className="flex items-center gap-2 bg-slate-50 border border-slate-100 p-3 rounded-xl">
                                                <Link2 className="w-4 h-4 text-slate-400 shrink-0" />
                                                <input
                                                    type="url"
                                                    value={block.captionLink || ''}
                                                    onChange={e => updateBlock(block.id, 'captionLink', e.target.value)}
                                                    placeholder="超連結 URL（選填）"
                                                    className="flex-1 bg-transparent border-none outline-none text-sm focus:ring-0"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                ) : block.type === 'video' ? (
                                    <div className="space-y-4">
                                        <div className="flex items-center gap-3 bg-slate-50 border border-slate-100 p-3 rounded-2xl">
                                            <Video className="w-5 h-5 text-purple-500" />
                                            <input
                                                type="url"
                                                value={block.video_url || ''}
                                                onChange={(e) => updateBlock(block.id, 'video_url', e.target.value)}
                                                onBlur={(e) => {
                                                    const converted = toEmbedUrl(e.target.value);
                                                    if (converted !== e.target.value) updateBlock(block.id, 'video_url', converted);
                                                }}
                                                onPaste={(e) => {
                                                    setTimeout(() => {
                                                        const val = e.target.value;
                                                        const converted = toEmbedUrl(val);
                                                        if (converted !== val) updateBlock(block.id, 'video_url', converted);
                                                    }, 0);
                                                }}
                                                placeholder="貼上 YouTube 連結（任何格式皆可）"
                                                className="flex-1 bg-transparent border-none outline-none text-sm font-mono focus:ring-0"
                                            />
                                        </div>
                                        {block.video_url ? (
                                            <div className="aspect-video bg-slate-900 rounded-2xl overflow-hidden shadow-inner ring-1 ring-slate-200">
                                                <iframe
                                                    src={toEmbedUrl(block.video_url)}
                                                    title={block.title}
                                                    className="w-full h-full"
                                                    allowFullScreen
                                                />
                                            </div>
                                        ) : (
                                            <div className="aspect-video bg-slate-100 rounded-2xl flex flex-col items-center justify-center text-slate-400 gap-2 border-2 border-dashed border-slate-200">
                                                <PlaySquare className="w-10 h-10 opacity-20" />
                                                <p className="text-xs font-bold">預覽區域：請輸入有效的嵌入連結</p>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="quill-minimal-editor" onClick={handleEditorClick}>
                                        <ReactQuill
                                            theme="snow"
                                            value={block.body || ''}
                                            onChange={(val) => updateBlock(block.id, 'body', val)}
                                            modules={quillModules}
                                            placeholder="在此輸入您的文章內容，可自由插入圖片與影片..."
                                        />
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}

                    {/* Add More button at bottom */}
                    {blocks.length > 0 && (
                        <div className="flex justify-center gap-4 py-8 border-t border-slate-200">
                            <button
                                onClick={addArticleBlock}
                                className="flex items-center gap-2 bg-white border border-slate-200 text-slate-700 px-6 py-3 rounded-2xl hover:border-blue-500 hover:text-blue-600 transition-all font-bold text-sm shadow-sm"
                            >
                                <Plus className="w-4 h-4" /> 新增文字區塊
                            </button>
                            <button
                                onClick={addVideoBlock}
                                className="flex items-center gap-2 bg-white border border-slate-200 text-slate-700 px-6 py-3 rounded-2xl hover:border-purple-500 hover:text-purple-600 transition-all font-bold text-sm shadow-sm"
                            >
                                <Plus className="w-4 h-4" /> 新增影片區塊
                            </button>
                            <button
                                onClick={addImageTextBlock}
                                className="flex items-center gap-2 bg-white border border-slate-200 text-slate-700 px-6 py-3 rounded-2xl hover:border-emerald-500 hover:text-emerald-600 transition-all font-bold text-sm shadow-sm"
                            >
                                <Plus className="w-4 h-4" /> 新增圖文區塊
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* ── 圖片大小調整浮動工具列 ── */}
            {activeImage && (
                <div
                    className="image-size-toolbar fixed z-50 bg-white shadow-xl rounded-xl border border-slate-200 p-2 flex items-center gap-1"
                    style={{
                        top: `${Math.min(activeImage.rect.bottom + 8, window.innerHeight - 60)}px`,
                        left: `${Math.max(8, activeImage.rect.left + activeImage.rect.width / 2 - 180)}px`,
                    }}
                >
                    <span className="text-[10px] text-slate-400 font-bold px-2 whitespace-nowrap">大小：</span>
                    {[
                        { label: '25%', w: '25%' },
                        { label: '33%', w: '33%' },
                        { label: '50%', w: '50%' },
                        { label: '75%', w: '75%' },
                        { label: '100%', w: '100%' },
                    ].map(opt => (
                        <button
                            key={opt.label}
                            onClick={() => applyImageSize(opt.w, null)}
                            className="px-2.5 py-1 text-xs font-bold rounded-lg hover:bg-blue-50 hover:text-blue-600 transition-colors"
                        >
                            {opt.label}
                        </button>
                    ))}
                    <div className="w-px h-5 bg-slate-200 mx-1" />
                    <span className="text-[10px] text-slate-400 font-bold px-1 whitespace-nowrap">對齊：</span>
                    <button onClick={() => applyImageSize(activeImage.element.style.width || '50%', 'left')}
                        className="px-2 py-1 text-xs font-bold rounded-lg hover:bg-emerald-50 hover:text-emerald-600 transition-colors" title="靠左（文繞圖）">⬅</button>
                    <button onClick={() => applyImageSize(activeImage.element.style.width || '100%', '')}
                        className="px-2 py-1 text-xs font-bold rounded-lg hover:bg-slate-100 transition-colors" title="置中（獨立行）">⬛</button>
                    <button onClick={() => applyImageSize(activeImage.element.style.width || '50%', 'right')}
                        className="px-2 py-1 text-xs font-bold rounded-lg hover:bg-emerald-50 hover:text-emerald-600 transition-colors" title="靠右（文繞圖）">➡</button>
                </div>
            )}

            <style dangerouslySetInnerHTML={{
                __html: `
                .quill-minimal-editor .ql-container {
                    font-size: 16px;
                    border: none !important;
                    min-height: 150px;
                }
                .quill-minimal-editor .ql-toolbar {
                    border: none !important;
                    border-bottom: 1px solid #f1f5f9 !important;
                    padding: 8px 0 !important;
                    background: #fff;
                    position: sticky;
                    top: 0;
                    z-index: 10;
                }
                .quill-minimal-editor .ql-editor {
                    padding: 20px 0 !important;
                    min-height: 150px;
                }
                .quill-minimal-editor .ql-editor img {
                    max-width: 100%;
                    border-radius: 12px;
                    cursor: pointer;
                    transition: box-shadow 0.2s;
                    display: inline-block;
                    vertical-align: top;
                }
                .quill-minimal-editor .ql-editor img:hover {
                    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.3);
                }
                .quill-minimal-editor .ql-editor iframe {
                    max-width: 100%;
                    border-radius: 12px;
                    margin: 8px 0;
                }
            `}} />
        </div>
    );
};

// Simple icon fallback if not provided by lucide
const PlaySquare = ({ className }) => (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="m9 8 7 4-7 4V8z" /></svg>
);

export default EditorComponent;
