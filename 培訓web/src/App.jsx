import { Component, lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';
import PendingApproval from './pages/PendingApproval';
import NotFound from './pages/NotFound';
import { canAccessInstructorContracts } from './lib/featureFlags';
import { isApprovedUser } from './lib/roles';

// 路由頁面依需求才下載：首頁、登入後導向的待審頁、Layout 與守衛留在入口 chunk，
// 其餘（含 pdf-lib／react-pdf／quill／jszip 等大型套件）各自成 chunk，講師手機首次開啟不必下載全站。
const AboutMe = lazy(() => import('./pages/AboutMe'));
const CourseList = lazy(() => import('./pages/CourseList'));
const LessonView = lazy(() => import('./pages/LessonView'));
const LessonDetail = lazy(() => import('./pages/LessonDetail'));
const AdminDashboard = lazy(() => import('./pages/admin/Dashboard'));
const CMSManager = lazy(() => import('./pages/admin/CMSManager'));
const CategoryManager = lazy(() => import('./pages/admin/CategoryManager'));
const AssignmentReview = lazy(() => import('./pages/admin/AssignmentReview'));
const TeacherManager = lazy(() => import('./pages/admin/TeacherManager'));
const ProgressOverview = lazy(() => import('./pages/admin/ProgressOverview'));
const AnnouncementManager = lazy(() => import('./pages/admin/AnnouncementManager'));
const AnnouncementDetail = lazy(() => import('./pages/AnnouncementDetail'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const InstructorList = lazy(() => import('./pages/admin/InstructorList'));
const AdminInstructorEdit = lazy(() => import('./pages/admin/AdminInstructorEdit'));
const ContractSigningFlow = lazy(() => import('./pages/ContractSigningFlow'));
const ContractView = lazy(() => import('./pages/ContractView'));
const ContractAdmin = lazy(() => import('./pages/admin/ContractAdmin'));
const SalaryRegister = lazy(() => import('./pages/admin/SalaryRegister'));
const SalaryVendorExport = lazy(() => import('./pages/admin/SalaryVendorExport'));
const SalaryPayoutExport = lazy(() => import('./pages/admin/SalaryPayoutExport'));
const SalaryReportOptionsManager = lazy(() => import('./pages/admin/SalaryReportOptionsManager'));
const MySalary = lazy(() => import('./pages/MySalary'));
const MySalaryNew = lazy(() => import('./pages/MySalaryNew'));
const DownloadCenter = lazy(() => import('./pages/admin/DownloadCenter'));
const BadgeManager = lazy(() => import('./pages/admin/BadgeManager'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const CubeTimer = lazy(() => import('./pages/CubeTimer'));
const SalaryLinksManager = lazy(() => import('./pages/admin/SalaryLinksManager'));
const NotificationManager = lazy(() => import('./pages/admin/NotificationManager'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));
const TermsOfService = lazy(() => import('./pages/TermsOfService'));

const ProtectedRoute = ({ children, adminOnly = false, staffOnly = false, allowPending = false, approvedOnly = false }) => {
  const { user, profile, claimState, loading } = useAuth();

  if (loading) return <div className="p-12 text-center text-slate-500 text-lg">載入中...</div>;
  if (!user) return <Navigate to="/" />;
  if (!profile) return <div className="p-12 text-center text-slate-500 text-lg">載入中...</div>;
  if (allowPending && claimState?.status === 'conflict') return <Navigate to="/pending" replace />;

  const isPrivileged = profile.role === 'admin' || profile.role === 'mentor';
  if (!allowPending && !isPrivileged && profile.role === 'pending') return <Navigate to="/pending" />;
  if (approvedOnly && !isApprovedUser(profile)) return <Navigate to="/" />;
  if (adminOnly && profile.role !== 'admin') return <Navigate to="/" />;
  if (staffOnly && profile.role !== 'admin' && profile.role !== 'mentor') return <Navigate to="/" />;

  return children;
};

const InstructorContractRoute = ({ children }) => {
  const { profile } = useAuth();

  if (!canAccessInstructorContracts(profile?.role)) {
    return <Navigate to="/profile" replace />;
  }

  return children;
};

// 頁面檔下載失敗（手機訊號差、剛好換版）時，只讓內容區顯示提示，導覽列還在，不讓整站變空白。
// 換到別的網址（resetKey 改變）時自動恢復；沒出錯時完全不影響子元件的保留與重建。
class PageErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(prevProps) {
    if (this.state.failed && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="min-h-[50vh] flex items-center justify-center p-6">
        <div className="bh-card bg-white p-8 max-w-md w-full text-center">
          <h1 className="text-xl font-black text-bauhaus-black mb-2">這個頁面暫時無法顯示</h1>
          <p className="text-bauhaus-black/60 font-medium mb-6">可能是網路不穩或剛好更新版本，請重新整理再試一次。</p>
          <button type="button" className="bh-btn bh-btn-blue px-6 py-3" onClick={() => window.location.reload()}>
            重新整理
          </button>
        </div>
      </div>
    );
  }
}

// 頁面骨架：Layout（導覽列）立即顯示，只有內容區在頁面檔下載期間顯示「載入中...」，不會整頁閃白。
// 所有路由都用同一個骨架，Layout 在路由之間保留或重建的行為和改動前完全一致。
const PageLayout = ({ children }) => {
  const { pathname } = useLocation();
  return (
    <Layout>
      <PageErrorBoundary resetKey={pathname}>
        <Suspense fallback={<div className="p-12 text-center text-slate-500 text-lg">載入中...</div>}>
          {children}
        </Suspense>
      </PageErrorBoundary>
    </Layout>
  );
};

function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          <Route path="/" element={<PageLayout><HomePage /></PageLayout>} />
          <Route path="/privacy" element={<PageLayout><PrivacyPolicy /></PageLayout>} />
          <Route path="/terms" element={<PageLayout><TermsOfService /></PageLayout>} />
          <Route path="/pending" element={<PageLayout><PendingApproval /></PageLayout>} />
          <Route
            path="/announcements/:id"
            element={
              <ProtectedRoute approvedOnly>
                <PageLayout><AnnouncementDetail /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/profile"
            element={
              <ProtectedRoute allowPending>
                <PageLayout><ProfilePage /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/me"
            element={
              <ProtectedRoute>
                <PageLayout><AboutMe /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/courses"
            element={
              <ProtectedRoute>
                <PageLayout><CourseList /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/leaderboard"
            element={
              <ProtectedRoute>
                <PageLayout><Leaderboard /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/cube"
            element={
              <ProtectedRoute>
                <PageLayout><CubeTimer /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/courses/:courseId"
            element={
              <ProtectedRoute>
                <PageLayout><LessonView /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/courses/:courseId/lessons/:lessonId"
            element={
              <ProtectedRoute>
                <PageLayout><LessonDetail /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute staffOnly={true}>
                <PageLayout><AdminDashboard /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/cms/:courseId"
            element={
              <ProtectedRoute staffOnly={true}>
                <PageLayout><CMSManager /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/course-categories"
            element={
              <ProtectedRoute adminOnly={true}>
                <PageLayout><CategoryManager /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/assignments"
            element={
              <ProtectedRoute staffOnly={true}>
                <PageLayout><AssignmentReview /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/teachers"
            element={
              <ProtectedRoute adminOnly={true}>
                <PageLayout><TeacherManager /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/progress"
            element={
              <ProtectedRoute staffOnly={true}>
                <PageLayout><ProgressOverview /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/announcements"
            element={
              <ProtectedRoute adminOnly={true}>
                <PageLayout><AnnouncementManager /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/instructors"
            element={
              <ProtectedRoute staffOnly={true}>
                <PageLayout><InstructorList /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/instructors/:instructorId/edit"
            element={
              <ProtectedRoute adminOnly={true}>
                <PageLayout><AdminInstructorEdit /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/claims"
            element={<Navigate to="/admin/instructors" replace />}
          />
          <Route
            path="/contract"
            element={
              <ProtectedRoute>
                <InstructorContractRoute>
                  <PageLayout><ContractSigningFlow /></PageLayout>
                </InstructorContractRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path="/contract/view/:contractId"
            element={
              <ProtectedRoute>
                <InstructorContractRoute>
                  <PageLayout><ContractView /></PageLayout>
                </InstructorContractRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/contracts"
            element={
              <ProtectedRoute adminOnly={true}>
                <PageLayout><ContractAdmin /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/salary"
            element={
              <ProtectedRoute staffOnly={true}>
                <PageLayout><SalaryRegister /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/salary/export"
            element={
              <ProtectedRoute adminOnly={true}>
                <PageLayout><SalaryVendorExport /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/salary/payout"
            element={
              <ProtectedRoute adminOnly={true}>
                <PageLayout><SalaryPayoutExport /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/salary/options"
            element={
              <ProtectedRoute adminOnly={true}>
                <PageLayout><SalaryReportOptionsManager /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/download-center"
            element={
              <ProtectedRoute staffOnly={true}>
                <PageLayout><DownloadCenter /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/badges"
            element={
              <ProtectedRoute adminOnly={true}>
                <PageLayout><BadgeManager /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/salary-links"
            element={
              <ProtectedRoute adminOnly={true}>
                <PageLayout><SalaryLinksManager /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/notifications"
            element={
              <ProtectedRoute adminOnly={true}>
                <PageLayout><NotificationManager /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/my/salary"
            element={
              <ProtectedRoute>
                <PageLayout><MySalary /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/my/salary/new"
            element={
              <ProtectedRoute>
                <PageLayout><MySalaryNew /></PageLayout>
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<PageLayout><NotFound /></PageLayout>} />
        </Routes>
      </Router>
    </AuthProvider>
  );
}

export default App;
