import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { Calendar, BookOpen, Users, Clock, MessageSquare, AlertCircle, Send, ArrowLeft } from 'lucide-react';
import { COURSE_LABELS, ROLE_LABELS } from '../lib/constants';

const MySalaryNew = () => {
    const { user, profile } = useAuth();
    const navigate = useNavigate();
    const [instructor, setInstructor] = useState(null);
    const [form, setForm] = useState({
        course_type: 'regular_basic',
        course_name: '',
        session_date: new Date().toISOString().slice(0, 10),
        role_in_session: 'lead',
        duration_hours: '',
        student_count: '',
        location: '',
        self_review: '',
        progress_note: '',
        incident_report: '',
    });
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!user) return;
        (async () => {
            const { data } = await supabase
                .from('instructors')
                .select('id, full_name, instructor_role')
                .eq('user_id', user.id)
                .maybeSingle();
            setInstructor(data);
        })();
    }, [user]);

    const submit = async () => {
        setError('');
        if (!form.course_type) { setError('請選擇課程類型'); return; }
        if (!form.session_date) { setError('請填寫日期'); return; }
        if (!instructor) { setError('找不到您的講師資料,請聯絡管理員'); return; }

        setSubmitting(true);
        const payload = {
            instructor_id: instructor.id,
            instructor_name: instructor.full_name,
            instructor_role_at_time: instructor.instructor_role,
            course_type: form.course_type,
            course_name: form.course_name || null,
            location: form.location || null,
            session_date: form.session_date,
            role_in_session: form.role_in_session,
            duration_hours: form.duration_hours ? Number(form.duration_hours) : null,
            student_count: form.student_count ? Number(form.student_count) : null,
            self_review: form.self_review || null,
            progress_note: form.progress_note || null,
            incident_report: form.incident_report || null,
            status: 'pending',           // 講師提交一律 pending,等待後台核薪
            base_salary: 0,
            bonus: 0,
            registered_by: user.id,
            registered_by_name: profile?.name || profile?.email,
            source: 'self_report',
        };
        const { error: err } = await supabase.from('class_sessions').insert(payload);
        setSubmitting(false);
        if (err) { setError(err.message); return; }
        navigate('/my/salary');
    };

    return (
        <div className="p-4 sm:p-8 max-w-3xl mx-auto">
            <Link to="/my/salary" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-blue-600 mb-4">
                <ArrowLeft className="w-4 h-4" /> 回我的薪資
            </Link>

            <div className="mb-6">
                <h1 className="text-2xl sm:text-3xl font-black text-slate-900">登記課程回報</h1>
                <p className="text-slate-500 mt-1 text-sm">
                    上完課後填寫這份回報,送出後管理員會審核並登記薪資。
                </p>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 flex gap-3">
                <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-sm text-amber-900">
                    <div className="font-bold">薪資金額不需要您填寫</div>
                    <div className="text-amber-700 mt-0.5 text-xs">
                        管理員會依照您填的時數/人數/課程類型,**依照官方報酬表自動核算**,
                        如有特殊情況可在「特殊狀況回報」說明。
                    </div>
                </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
                {/* 課程基本資訊 */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label="課程類型 *" icon={BookOpen}>
                        <select value={form.course_type} onChange={e => setForm({ ...form, course_type: e.target.value })}
                            className="w-full px-3 py-2 rounded-lg border border-slate-200 outline-none focus:border-blue-400">
                            {Object.entries(COURSE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                    </Field>

                    <Field label="日期 *" icon={Calendar}>
                        <input type="date" value={form.session_date} onChange={e => setForm({ ...form, session_date: e.target.value })}
                            className="w-full px-3 py-2 rounded-lg border border-slate-200 outline-none focus:border-blue-400" />
                    </Field>

                    <Field label="角色">
                        <select value={form.role_in_session} onChange={e => setForm({ ...form, role_in_session: e.target.value })}
                            className="w-full px-3 py-2 rounded-lg border border-slate-200 outline-none focus:border-blue-400">
                            {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                    </Field>

                    <Field label="課程名稱">
                        <input type="text" placeholder="例:OO 國小週二班" value={form.course_name}
                            onChange={e => setForm({ ...form, course_name: e.target.value })}
                            className="w-full px-3 py-2 rounded-lg border border-slate-200 outline-none focus:border-blue-400" />
                    </Field>

                    <Field label="時數" icon={Clock}>
                        <input type="number" step="0.5" placeholder="例:1.5" value={form.duration_hours}
                            onChange={e => setForm({ ...form, duration_hours: e.target.value })}
                            className="w-full px-3 py-2 rounded-lg border border-slate-200 outline-none focus:border-blue-400" />
                    </Field>

                    <Field label="人數" icon={Users}>
                        <input type="number" placeholder="例:6" value={form.student_count}
                            onChange={e => setForm({ ...form, student_count: e.target.value })}
                            className="w-full px-3 py-2 rounded-lg border border-slate-200 outline-none focus:border-blue-400" />
                    </Field>

                    <Field label="地點" full>
                        <input type="text" placeholder="選填" value={form.location}
                            onChange={e => setForm({ ...form, location: e.target.value })}
                            className="w-full px-3 py-2 rounded-lg border border-slate-200 outline-none focus:border-blue-400" />
                    </Field>
                </div>

                <hr className="border-slate-100" />

                {/* 講師回報 */}
                <Field label="課程自評" icon={MessageSquare}>
                    <textarea rows={3} placeholder="這場課的整體狀況、學生反應..." value={form.self_review}
                        onChange={e => setForm({ ...form, self_review: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 outline-none focus:border-blue-400" />
                </Field>

                <Field label="學習進度（常態課必填）">
                    <textarea rows={2} placeholder="今天教到哪個段落、下一場預計教什麼..." value={form.progress_note}
                        onChange={e => setForm({ ...form, progress_note: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 outline-none focus:border-blue-400" />
                </Field>

                <Field label="特殊狀況回報">
                    <textarea rows={2} placeholder="如有突發狀況、需要管理員注意的事(例:臨時換教室、學員缺席...)" value={form.incident_report}
                        onChange={e => setForm({ ...form, incident_report: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 outline-none focus:border-blue-400" />
                </Field>

                {error && <div className="text-sm text-rose-600 bg-rose-50 px-3 py-2 rounded-lg">{error}</div>}

                <div className="flex justify-end gap-3 pt-2">
                    <Link to="/my/salary" className="px-5 py-2.5 rounded-lg text-slate-600 hover:bg-slate-100 font-medium">取消</Link>
                    <button onClick={submit} disabled={submitting}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50">
                        <Send className="w-4 h-4" />
                        {submitting ? '送出中...' : '送出回報'}
                    </button>
                </div>
            </div>
        </div>
    );
};

const Field = ({ label, icon: Icon, children, full = false }) => (
    <div className={full ? 'sm:col-span-2' : ''}>
        <label className="flex items-center gap-1 text-xs font-bold text-slate-600 mb-1.5">
            {Icon && <Icon className="w-3.5 h-3.5" />} {label}
        </label>
        {children}
    </div>
);

export default MySalaryNew;
