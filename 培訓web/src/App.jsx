import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';
import PendingApproval from './pages/PendingApproval';
import CourseList from './pages/CourseList';
import LessonView from './pages/LessonView';
import LessonDetail from './pages/LessonDetail';
import AdminDashboard from './pages/admin/Dashboard';
import CMSManager from './pages/admin/CMSManager';
import CategoryManager from './pages/admin/CategoryManager';
import AssignmentReview from './pages/admin/AssignmentReview';
import TeacherManager from './pages/admin/TeacherManager';
import ProgressOverview from './pages/admin/ProgressOverview';
import AnnouncementManager from './pages/admin/AnnouncementManager';
import AnnouncementDetail from './pages/AnnouncementDetail';
import ProfilePage from './pages/ProfilePage';
import InstructorList from './pages/admin/InstructorList';
import ContractSigningFlow from './pages/ContractSigningFlow';
import ContractView from './pages/ContractView';
import ContractAdmin from './pages/admin/ContractAdmin';
import SalaryRegister from './pages/admin/SalaryRegister';
import MySalary from './pages/MySalary';
import MySalaryNew from './pages/MySalaryNew';
import ClaimRequests from './pages/admin/ClaimRequests';
import DownloadCenter from './pages/admin/DownloadCenter';
import BadgeManager from './pages/admin/BadgeManager';
import Leaderboard from './pages/Leaderboard';
import CubeTimer from './pages/CubeTimer';
import SalaryLinksManager from './pages/admin/SalaryLinksManager';
import NotificationManager from './pages/admin/NotificationManager';
import { canAccessInstructorContracts } from './lib/featureFlags';

const ProtectedRoute = ({ children, adminOnly = false, staffOnly = false, allowPending = false }) => {
  const { user, profile, loading } = useAuth();

  if (loading) return <div className="p-12 text-center text-slate-500 text-lg">載入中...</div>;
  if (!user) return <Navigate to="/" />;
  if (!profile) return <div className="p-12 text-center text-slate-500 text-lg">載入中...</div>;

  const isPrivileged = profile.role === 'admin' || profile.role === 'mentor';
  if (!allowPending && !isPrivileged && profile.role === 'pending') return <Navigate to="/pending" />;
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

function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          <Route path="/" element={<Layout><HomePage /></Layout>} />
          <Route path="/pending" element={<Layout><PendingApproval /></Layout>} />
          <Route path="/announcements/:id" element={<Layout><AnnouncementDetail /></Layout>} />
          <Route
            path="/profile"
            element={
              <ProtectedRoute allowPending>
                <Layout><ProfilePage /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/courses"
            element={
              <ProtectedRoute>
                <Layout><CourseList /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/leaderboard"
            element={
              <ProtectedRoute>
                <Layout><Leaderboard /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/cube"
            element={
              <ProtectedRoute>
                <Layout><CubeTimer /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/courses/:courseId"
            element={
              <ProtectedRoute>
                <Layout><LessonView /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/courses/:courseId/lessons/:lessonId"
            element={
              <ProtectedRoute>
                <Layout><LessonDetail /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute staffOnly={true}>
                <Layout><AdminDashboard /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/cms/:courseId"
            element={
              <ProtectedRoute staffOnly={true}>
                <Layout><CMSManager /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/course-categories"
            element={
              <ProtectedRoute adminOnly={true}>
                <Layout><CategoryManager /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/assignments"
            element={
              <ProtectedRoute staffOnly={true}>
                <Layout><AssignmentReview /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/teachers"
            element={
              <ProtectedRoute adminOnly={true}>
                <Layout><TeacherManager /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/progress"
            element={
              <ProtectedRoute staffOnly={true}>
                <Layout><ProgressOverview /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/announcements"
            element={
              <ProtectedRoute adminOnly={true}>
                <Layout><AnnouncementManager /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/instructors"
            element={
              <ProtectedRoute staffOnly={true}>
                <Layout><InstructorList /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/claims"
            element={
              <ProtectedRoute adminOnly={true}>
                <Layout><ClaimRequests /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/contract"
            element={
              <ProtectedRoute>
                <InstructorContractRoute>
                  <Layout><ContractSigningFlow /></Layout>
                </InstructorContractRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path="/contract/view/:contractId"
            element={
              <ProtectedRoute>
                <InstructorContractRoute>
                  <Layout><ContractView /></Layout>
                </InstructorContractRoute>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/contracts"
            element={
              <ProtectedRoute adminOnly={true}>
                <Layout><ContractAdmin /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/salary"
            element={
              <ProtectedRoute staffOnly={true}>
                <Layout><SalaryRegister /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/download-center"
            element={
              <ProtectedRoute staffOnly={true}>
                <Layout><DownloadCenter /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/badges"
            element={
              <ProtectedRoute adminOnly={true}>
                <Layout><BadgeManager /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/salary-links"
            element={
              <ProtectedRoute adminOnly={true}>
                <Layout><SalaryLinksManager /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/notifications"
            element={
              <ProtectedRoute adminOnly={true}>
                <Layout><NotificationManager /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/my/salary"
            element={
              <ProtectedRoute>
                <Layout><MySalary /></Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/my/salary/new"
            element={
              <ProtectedRoute>
                <Layout><MySalaryNew /></Layout>
              </ProtectedRoute>
            }
          />
        </Routes>
      </Router>
    </AuthProvider>
  );
}

export default App;
