import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { Megaphone, Plus, Edit2, Trash2, Pin, PinOff, Eye, EyeOff, X, Save } from 'lucide-react';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';

const QUILL_MODULES = {
    toolbar: [
        [{ header: [1, 2, 3, false] }],
        ['bold', 'italic', 'underline', 'strike'],
        ['blockquote'],
        [{ list: 'ordered' }, { list: 'bullet' }],
        [{ color: [] }, { background: [] }],
        [{ align: [] }],
        ['link', 'image'],
        ['clean'],
    ],
};

const EMPTY_FORM = { title: '', content: '', tag: '一般公告', pinned: false, published: true };

const AnnouncementManager = () => {
    const [announcements, setAnnouncements] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(null);
    const [form, setForm] = useState(EMPTY_FORM);

    useEffect(() => {
        fetchAnnouncements();
    }, []);

    const fetchAnnouncements = async () => {
        setLoading(true);
        const { data } = await supabase
            .from('announcements')
            .select('*')
            .order('pinned', { ascending: false })
            .order('created_at', { ascending: false });
        setAnnouncements(data || []);
        setLoading(false);
    };

    const openCreate = () => {
        setEditing('new');
        setForm(EMPTY_FORM);
    };

    const openEdit = (a) => {
        setEditing(a.id);
        setForm({ title: a.title, content: a.content, tag: a.tag, pinned: a.pinned, published: a.published });
    };

    const cancelEdit = () => {
        setEditing(null);
        setForm(EMPTY_FORM);
    };

    const handleSave = async () => {
        if (!form.title || !form.content) {
            alert('請填寫標題與內容');
            return;
        }

        if (editing === 'new') {
            const { data: inserted, error } = await supabase.from('announcements').insert({
                title: form.title,
                content: form.content,
                tag: form.tag,
                pinned: form.pinned,
                published: form.published,
            }).select('id').single();
            if (error) { alert('新增失敗：' + error.message); return; }

            if (form.published && inserted) {
                const { data: allUsers } = await supabase
                    .from('users')
                    .select('id')
                    .neq('role', 'pending');
                if (allUsers && allUsers.length > 0) {
                    const notifs = allUsers.map(u => ({
                        user_id: u.id,
                        type: 'announcement',
                        title: '新公告',
                        body: form.title,
                        link: `/announcements/${inserted.id}`,
                    }));
                    await supabase.from('notifications').insert(notifs);
                }
            }
        } else {
            const { error } = await supabase.from('announcements').update({
                title: form.title,
                content: form.content,
                tag: form.tag,
                pinned: form.pinned,
                published: form.published,
                updated_at: new Date().toISOString(),
            }).eq('id', editing);
            if (error) { alert('更新失敗：' + error.message); return; }
        }

        cancelEdit();
        fetchAnnouncements();
    };

    const handleDelete = async (id) => {
        if (!window.confirm('確定要刪除這則公告嗎？')) return;
        const { error } = await supabase.from('announcements').delete().eq('id', id);
        if (error) { alert('刪除失敗：' + error.message); return; }
        setAnnouncements(announcements.filter(a => a.id !== id));
    };

    const togglePinned = async (a) => {
        const { error } = await supabase.from('announcements').update({ pinned: !a.pinned }).eq('id', a.id);
        if (error) return;
        setAnnouncements(announcements.map(x => x.id === a.id ? { ...x, pinned: !x.pinned } : x));
    };

    const togglePublished = async (a) => {
        const { error } = await supabase.from('announcements').update({ published: !a.published }).eq('id', a.id);
        if (error) return;
        setAnnouncements(announcements.map(x => x.id === a.id ? { ...x, published: !x.published } : x));
    };

    if (loading) return <div className="p-12 text-center text-bauhaus-black/50 font-bold uppercase tracking-wide">載入中...</div>;

    return (
        <div className="p-4 sm:p-8 max-w-5xl mx-auto">
            <div className="flex items-center justify-between mb-8 gap-3">
                <div>
                    <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">佈告欄管理</h1>
                    <p className="text-bauhaus-black/60 font-medium mt-1">管理首頁顯示的公告內容</p>
                </div>
                <button
                    onClick={openCreate}
                    className="bh-btn bh-btn-blue px-6 py-3 shrink-0"
                >
                    <Plus className="w-5 h-5" /> 新增公告
                </button>
            </div>

            {/* Edit / Create form */}
            {editing && (
                <div className="bh-card shadow-hard-lg p-6 mb-8">
                    <div className="flex items-center justify-between mb-5">
                        <h3 className="font-black text-bauhaus-black flex items-center gap-2 uppercase tracking-wide text-sm">
                            <Megaphone className="w-5 h-5 text-bauhaus-black" />
                            {editing === 'new' ? '新增公告' : '編輯公告'}
                        </h3>
                        <button onClick={cancelEdit} className="relative p-1.5 text-bauhaus-black/40 hover:text-bauhaus-black hover:bg-bauhaus-muted transition-colors before:absolute before:-inset-2 before:content-['']">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                    <div className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="bh-label block mb-1">標題</label>
                                <input
                                    type="text"
                                    value={form.title}
                                    onChange={e => setForm({ ...form, title: e.target.value })}
                                    className="bh-input"
                                    placeholder="公告標題"
                                />
                            </div>
                            <div>
                                <label className="bh-label block mb-1">標籤分類</label>
                                <select
                                    value={form.tag}
                                    onChange={e => setForm({ ...form, tag: e.target.value })}
                                    className="bh-input"
                                >
                                    <option value="重要公告">重要公告</option>
                                    <option value="課程更新">課程更新</option>
                                    <option value="提醒">提醒</option>
                                    <option value="一般公告">一般公告</option>
                                    <option value="活動">活動</option>
                                </select>
                            </div>
                        </div>
                        <div>
                            <label className="bh-label block mb-1">內容</label>
                            <div className="quill-wrapper bg-white border-2 border-bauhaus-black overflow-hidden">
                                <ReactQuill
                                    theme="snow"
                                    value={form.content}
                                    onChange={val => setForm({ ...form, content: val })}
                                    modules={QUILL_MODULES}
                                    placeholder="在此輸入公告內容，可插入圖片、連結..."
                                />
                            </div>
                        </div>
                        <div className="flex items-center gap-6">
                            <label className="flex items-center gap-2 text-sm font-bold text-bauhaus-black cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={form.pinned}
                                    onChange={e => setForm({ ...form, pinned: e.target.checked })}
                                    className="w-4 h-4 border-2 border-bauhaus-black rounded-none text-bauhaus-red"
                                />
                                置頂公告
                            </label>
                            <label className="flex items-center gap-2 text-sm font-bold text-bauhaus-black cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={form.published}
                                    onChange={e => setForm({ ...form, published: e.target.checked })}
                                    className="w-4 h-4 border-2 border-bauhaus-black rounded-none text-bauhaus-blue"
                                />
                                立即發佈
                            </label>
                        </div>
                        <div className="flex justify-end">
                            <button
                                onClick={handleSave}
                                className="bh-btn bh-btn-blue px-8 py-2.5"
                            >
                                <Save className="w-4 h-4" /> 儲存
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Announcement list */}
            <div className="space-y-4">
                {announcements.map(a => (
                    <div
                        key={a.id}
                        className={`bh-card p-6 ${a.pinned ? 'border-bauhaus-red' : ''} ${!a.published ? 'opacity-60' : ''}`}
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                                <div className="flex items-center gap-2 mb-2 flex-wrap">
                                    {a.pinned && (
                                        <span className="bh-chip bg-bauhaus-red text-white">
                                            <Pin className="w-3 h-3" /> 置頂
                                        </span>
                                    )}
                                    <span className={`bh-chip ${
                                        a.tag === '重要公告' ? 'bg-bauhaus-red text-white'
                                            : a.tag === '課程更新' ? 'bg-bauhaus-blue text-white'
                                                : a.tag === '提醒' ? 'bg-bauhaus-yellow text-bauhaus-black'
                                                    : 'bg-bauhaus-muted text-bauhaus-black'
                                    }`}>
                                        {a.tag}
                                    </span>
                                    {!a.published && (
                                        <span className="bh-chip bg-bauhaus-muted text-bauhaus-black">未發佈</span>
                                    )}
                                    <span className="text-[11px] text-bauhaus-black/40 font-bold">
                                        {new Date(a.created_at).toLocaleDateString()}
                                    </span>
                                </div>
                                <h3 className="font-black text-bauhaus-black mb-1">{a.title}</h3>
                                <div className="text-sm text-bauhaus-black/60 leading-relaxed line-clamp-2 [&_img]:hidden [&_p]:m-0" dangerouslySetInnerHTML={{ __html: a.content }} />
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                                <button onClick={() => togglePinned(a)} className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-bauhaus-black/30 hover:text-bauhaus-red transition-colors" title={a.pinned ? '取消置頂' : '置頂'}>
                                    {a.pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
                                </button>
                                <button onClick={() => togglePublished(a)} className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-bauhaus-black/30 hover:text-bauhaus-blue transition-colors" title={a.published ? '取消發佈' : '發佈'}>
                                    {a.published ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                                <button onClick={() => openEdit(a)} className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-bauhaus-black/30 hover:text-bauhaus-blue transition-colors">
                                    <Edit2 className="w-4 h-4" />
                                </button>
                                <button onClick={() => handleDelete(a.id)} className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-bauhaus-black/30 hover:text-bauhaus-red transition-colors">
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
                {announcements.length === 0 && (
                    <div className="py-20 text-center bg-bauhaus-paper border-2 border-dashed border-bauhaus-black/30">
                        <Megaphone className="w-10 h-10 text-bauhaus-black/20 mx-auto mb-3" />
                        <p className="text-bauhaus-black/40 font-bold">尚未建立任何公告</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default AnnouncementManager;
