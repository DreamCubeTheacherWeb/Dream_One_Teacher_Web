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

    if (loading) return <div className="p-12 text-center text-slate-500">載入中...</div>;

    return (
        <div className="p-8 max-w-5xl mx-auto">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-3xl font-black text-slate-900">佈告欄管理</h1>
                    <p className="text-slate-500 mt-1">管理首頁顯示的公告內容</p>
                </div>
                <button
                    onClick={openCreate}
                    className="bg-blue-600 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20"
                >
                    <Plus className="w-5 h-5" /> 新增公告
                </button>
            </div>

            {/* Edit / Create form */}
            {editing && (
                <div className="bg-white rounded-2xl border border-blue-200 shadow-lg p-6 mb-8">
                    <div className="flex items-center justify-between mb-5">
                        <h3 className="font-bold text-slate-900 flex items-center gap-2">
                            <Megaphone className="w-5 h-5 text-blue-600" />
                            {editing === 'new' ? '新增公告' : '編輯公告'}
                        </h3>
                        <button onClick={cancelEdit} className="relative p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 before:absolute before:-inset-2 before:content-['']">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                    <div className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">標題</label>
                                <input
                                    type="text"
                                    value={form.title}
                                    onChange={e => setForm({ ...form, title: e.target.value })}
                                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500"
                                    placeholder="公告標題"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">標籤分類</label>
                                <select
                                    value={form.tag}
                                    onChange={e => setForm({ ...form, tag: e.target.value })}
                                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500"
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
                            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">內容</label>
                            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden [&_.ql-toolbar]:border-0 [&_.ql-toolbar]:border-b [&_.ql-toolbar]:border-slate-200 [&_.ql-toolbar]:bg-slate-50 [&_.ql-container]:border-0 [&_.ql-editor]:min-h-[180px] [&_.ql-editor]:text-sm [&_.ql-editor]:leading-relaxed">
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
                            <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={form.pinned}
                                    onChange={e => setForm({ ...form, pinned: e.target.checked })}
                                    className="w-4 h-4 rounded text-red-500"
                                />
                                置頂公告
                            </label>
                            <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={form.published}
                                    onChange={e => setForm({ ...form, published: e.target.checked })}
                                    className="w-4 h-4 rounded text-blue-600"
                                />
                                立即發佈
                            </label>
                        </div>
                        <div className="flex justify-end">
                            <button
                                onClick={handleSave}
                                className="bg-blue-600 text-white px-8 py-2.5 rounded-xl font-bold flex items-center gap-2 hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20"
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
                        className={`bg-white rounded-2xl border p-6 transition-all ${a.pinned ? 'border-red-200 shadow-md' : 'border-slate-150 shadow-sm'} ${!a.published ? 'opacity-60' : ''}`}
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                                <div className="flex items-center gap-2 mb-2">
                                    {a.pinned && (
                                        <span className="text-[10px] font-black text-red-500 bg-red-50 px-2 py-0.5 rounded-full flex items-center gap-1">
                                            <Pin className="w-3 h-3" /> 置頂
                                        </span>
                                    )}
                                    <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${
                                        a.tag === '重要公告' ? 'bg-red-50 text-red-600'
                                            : a.tag === '課程更新' ? 'bg-blue-50 text-blue-600'
                                                : a.tag === '提醒' ? 'bg-amber-50 text-amber-600'
                                                    : 'bg-slate-100 text-slate-500'
                                    }`}>
                                        {a.tag}
                                    </span>
                                    {!a.published && (
                                        <span className="text-[10px] font-black text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">未發佈</span>
                                    )}
                                    <span className="text-[11px] text-slate-400">
                                        {new Date(a.created_at).toLocaleDateString()}
                                    </span>
                                </div>
                                <h3 className="font-bold text-slate-900 mb-1">{a.title}</h3>
                                <div className="text-sm text-slate-500 leading-relaxed line-clamp-2 [&_img]:hidden [&_p]:m-0" dangerouslySetInnerHTML={{ __html: a.content }} />
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                                <button onClick={() => togglePinned(a)} className="p-2 text-slate-300 hover:text-red-500 transition-colors" title={a.pinned ? '取消置頂' : '置頂'}>
                                    {a.pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
                                </button>
                                <button onClick={() => togglePublished(a)} className="p-2 text-slate-300 hover:text-blue-600 transition-colors" title={a.published ? '取消發佈' : '發佈'}>
                                    {a.published ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                                <button onClick={() => openEdit(a)} className="p-2 text-slate-300 hover:text-blue-600 transition-colors">
                                    <Edit2 className="w-4 h-4" />
                                </button>
                                <button onClick={() => handleDelete(a.id)} className="p-2 text-slate-300 hover:text-red-500 transition-colors">
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
                {announcements.length === 0 && (
                    <div className="py-20 text-center bg-slate-50 rounded-3xl border-2 border-dashed border-slate-200">
                        <Megaphone className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                        <p className="text-slate-400 font-medium">尚未建立任何公告</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default AnnouncementManager;
