import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Shell from './components/Shell';
import ConnectionsPage from './pages/ConnectionsPage';
import FormsPage from './pages/FormsPage';
import MenusPage from './pages/MenusPage';
import ComparePage from './pages/ComparePage';
import DiagnosticPage from './pages/DiagnosticPage';
import WorkflowPage from './pages/WorkflowPage';
import WorkflowComparePage from './pages/WorkflowComparePage';
import FormLayoutPage from './pages/FormLayoutPage';
import RecentChangesPage from './pages/RecentChangesPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Shell />}>
          <Route index element={<Navigate to="/connections" replace />} />
          <Route path="connections" element={<ConnectionsPage />} />
          <Route path="forms" element={<FormsPage />} />
          <Route path="menus" element={<MenusPage />} />
          <Route path="workflow" element={<WorkflowPage />} />
          <Route path="compare" element={<ComparePage />} />
          <Route path="workflow-compare" element={<WorkflowComparePage />} />
          <Route path="layout" element={<FormLayoutPage />} />
          <Route path="recent" element={<RecentChangesPage />} />
          <Route path="diagnostic" element={<DiagnosticPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
