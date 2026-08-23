import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Edit3, Eye, EyeOff, Layers3, Plus, Save, Trash2, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import {
    TRAINING_VISIBILITY_OPTIONS,
    trainingVisibilityClass,
    trainingVisibilityLabel,
} from '../../lib/courseCategories';

const EMPTY_FORM = {
    title: '',
    description: '',
    visibility: 'all',
    is_published: false,
    order: 0,
};

const CategoryManager = () => {
    const [categories, setCategories] = useState([]);
    const [courseCounts, setCourseCounts] = useState({});
    const [form, setForm] = useState(EMPTY_FORM);
    const [editingId, setEditingId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const nextOrder = useMemo(() => (
        categories.length > 0 ? Math.max(...categories.map(item => item.order || 0)) + 1 : 0
    ), [categories]);

    const fetchData = async () => {
        const [{ data: categoryData, error: categoryError }, { data: courseData, error: courseError }] = await Promise.all([
            supabase.from('course_categories').select('*').order('order', { ascending: true }),
            supabase.from('courses').select('id, category_id'),
        ]);

        if (categoryError || courseError) {
            alert('讀取大分類失敗：' + (categoryError?.message || courseError?.message));
        }

        const counts = {};
        (courseData || []).forEach(course => {
            counts[course.category_id] = (counts[course.category_id] || 0) + 1;
        });
        setCategories(categoryData || []);
        setCourseCounts(counts);
        setLoading(false);
        return categoryData || [];
    };

    useEffect(() => {
        const timerId = window.setTimeout(async () => {
            const loadedCategories = await fetchData();
            const initialOrder = loadedCategories.length > 0
                ? Math.max(...loadedCategories.map(item => item.order || 0)) + 1
                : 0;
            setForm(current => ({ ...current, order: initialOrder }));
        }, 0);
        return () => window.clearTimeout(timerId);
    }, []);

    const resetForm = () => {
        setEditingId(null);
        setForm({ ...EMPTY_FORM, order: nextOrder });
    };

    const editCategory = (category) => {
        setEditingId(category.id);
        setForm({
            title: category.title || '',
            description: category.description || '',
            visibility: category.visibility || 'all',
            is_published: !!category.is_published,
            order: category.order || 0,
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const saveCategory = async (event) => {
        event.preventDefault();
        const title = form.title.trim();
        if (!title) {
            alert('請輸入大分類名稱');
            return;
        }

        setSaving(true);
        const payload = {
            ...form,
            title,
            description: form.description.trim() || null,
            order: Number.isFinite(Number(form.order)) ? Number(form.order) : 0,
            updated_at: new Date().toISOString(),
        };

        const { error } = editingId
            ? await supabase.from('course_categories').update(payload).eq('id', editingId)
            : await supabase.from('course_categories').insert(payload);

        setSaving(false);
        if (error) {
            alert('儲存大分類失敗：' + error.message);
            return;
        }

        const refreshedCategories = await fetchData();
        const refreshedNextOrder = refreshedCategories.length > 0
            ? Math.max(...refreshedCategories.map(item => item.order || 0)) + 1
            : 0;
        setEditingId(null);
        setForm({ ...EMPTY_FORM, order: refreshedNextOrder });
    };

    const deleteCategory = async (category) => {
        const count = courseCounts[category.id] || 0;
        if (count > 0) {
            alert(`「${category.title}」仍有 ${count} 門課程，請先把課程移到其他大分類。`);
            return;
        }
        if (!window.confirm(`確定要刪除大分類「${category.title}」嗎？`)) return;

        const { error } = await supabase.from('course_categories').delete().eq('id', category.id);
        if (error) {
            alert('刪除失敗：' + error.message);
            return;
        }
        setCategories(current => current.filter(item => item.id !== category.id));
        if (editingId === category.id) resetForm();
    };

    if (loading) {
        return <div className="p-12 text-center text-bauhaus-black/50 font-bold">大分類載入中...</div>;
    }

    return (
        <div className="p-4 sm:p-8 max-w-6xl mx-auto">
            <Link
                to="/admin"
                className="inline-flex items-center gap-1 font-bold text-bauhaus-black/60 hover:text-bauhaus-blue transition-colors min-h-[44px] mb-5"
            >
                <ChevronLeft className="w-4 h-4" /> 返回管理後台
            </Link>

            <div className="mb-8">
                <div className="flex items-center gap-3">
                    <span className="w-12 h-12 border-2 border-bauhaus-black bg-bauhaus-yellow rounded-xl flex items-center justify-center shadow-hard-sm">
                        <Layers3 className="w-6 h-6" />
                    </span>
                    <div>
                        <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">課程大分類</h1>
                        <p className="text-bauhaus-black/60 font-medium mt-1">管理前台第一層入口與可見對象</p>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-8 items-start">
                <form onSubmit={saveCategory} className="bh-card p-6 lg:sticky lg:top-6">
                    <div className="flex items-center justify-between gap-3 mb-5">
                        <h2 className="font-black text-bauhaus-black uppercase tracking-wide text-sm">
                            {editingId ? '編輯大分類' : '新增大分類'}
                        </h2>
                        {editingId && (
                            <button type="button" onClick={resetForm} className="p-2 text-bauhaus-black/50 hover:text-bauhaus-red" title="取消編輯">
                                <X className="w-4 h-4" />
                            </button>
                        )}
                    </div>

                    <div className="space-y-4">
                        <div>
                            <label htmlFor="category-title" className="bh-label block mb-1">分類名稱</label>
                            <input
                                id="category-title"
                                value={form.title}
                                onChange={event => setForm(current => ({ ...current, title: event.target.value }))}
                                className="bh-input"
                                placeholder="例如：新進講師培訓"
                                maxLength={80}
                                required
                            />
                        </div>
                        <div>
                            <label htmlFor="category-description" className="bh-label block mb-1">分類說明</label>
                            <textarea
                                id="category-description"
                                value={form.description}
                                onChange={event => setForm(current => ({ ...current, description: event.target.value }))}
                                className="bh-input resize-none"
                                rows="4"
                                maxLength={300}
                                placeholder="簡短說明這組課程的用途"
                            />
                        </div>
                        <div>
                            <label htmlFor="category-visibility" className="bh-label block mb-1">可見對象</label>
                            <select
                                id="category-visibility"
                                value={form.visibility}
                                onChange={event => setForm(current => ({ ...current, visibility: event.target.value }))}
                                className="bh-input"
                            >
                                {TRAINING_VISIBILITY_OPTIONS.map(option => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                            </select>
                            <p className="mt-1.5 text-xs font-medium text-bauhaus-black/50">大分類不可見時，其中所有課程、章節與內容都無法讀取。</p>
                        </div>
                        <div>
                            <label htmlFor="category-order" className="bh-label block mb-1">排序</label>
                            <input
                                id="category-order"
                                type="number"
                                value={form.order}
                                onChange={event => setForm(current => ({ ...current, order: event.target.value }))}
                                className="bh-input"
                            />
                        </div>
                        <label className="flex items-center gap-2 min-h-[44px] cursor-pointer">
                            <input
                                type="checkbox"
                                checked={form.is_published}
                                onChange={event => setForm(current => ({ ...current, is_published: event.target.checked }))}
                                className="w-5 h-5 border-2 border-bauhaus-black rounded-none text-bauhaus-blue"
                            />
                            <span className="text-sm font-bold text-bauhaus-black">發佈此大分類</span>
                        </label>
                    </div>

                    <button type="submit" disabled={saving} className="bh-btn bh-btn-blue w-full justify-center mt-5 min-h-[44px] disabled:opacity-50">
                        {editingId ? <Save className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                        {saving ? '儲存中...' : editingId ? '儲存變更' : '建立大分類'}
                    </button>
                </form>

                <section className="space-y-4" aria-labelledby="category-list-title">
                    <div className="flex items-end justify-between gap-3">
                        <div>
                            <h2 id="category-list-title" className="text-xl font-black text-bauhaus-black">現有大分類</h2>
                            <p className="text-sm font-medium text-bauhaus-black/50 mt-1">共 {categories.length} 個分類</p>
                        </div>
                    </div>

                    {categories.length > 0 ? categories.map((category, index) => (
                        <article key={category.id} className="bh-card p-5 sm:p-6 relative overflow-hidden">
                            <span
                                aria-hidden="true"
                                className={`absolute top-0 left-0 w-2 h-full ${['bg-bauhaus-red', 'bg-bauhaus-blue', 'bg-bauhaus-yellow'][index % 3]}`}
                            />
                            <div className="pl-3 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2 mb-2">
                                        <h3 className="text-lg font-black text-bauhaus-black">{category.title}</h3>
                                        <span className={`bh-chip ${trainingVisibilityClass(category.visibility)}`}>
                                            {trainingVisibilityLabel(category.visibility, true)}
                                        </span>
                                        <span className={`bh-chip ${category.is_published ? 'bg-bauhaus-blue text-white' : 'bg-bauhaus-muted text-bauhaus-black'}`}>
                                            {category.is_published ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                                            {category.is_published ? '已發佈' : '草稿'}
                                        </span>
                                    </div>
                                    <p className="text-sm text-bauhaus-black/60 font-medium leading-relaxed">
                                        {category.description || '尚未填寫分類說明'}
                                    </p>
                                    <div className="mt-3 flex flex-wrap gap-3 text-xs font-black text-bauhaus-black/45">
                                        <span>{courseCounts[category.id] || 0} 門課程</span>
                                        <span>排序 {category.order}</span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <button onClick={() => editCategory(category)} className="bh-btn bh-btn-outline text-xs px-3 py-2 min-h-[44px]">
                                        <Edit3 className="w-3.5 h-3.5" /> 編輯
                                    </button>
                                    <button
                                        onClick={() => deleteCategory(category)}
                                        className="p-3 text-bauhaus-black/40 hover:text-bauhaus-red hover:bg-bauhaus-red/10 transition-colors min-h-[44px] min-w-[44px]"
                                        title="刪除大分類"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        </article>
                    )) : (
                        <div className="bh-card p-12 text-center text-bauhaus-black/50 font-bold">
                            尚未建立大分類
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
};

export default CategoryManager;
