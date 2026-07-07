import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Shell from './components/Shell';
import ConnectionsPage from './pages/ConnectionsPage';
import ActiveLinksPage from './pages/ActiveLinksPage';
import FiltersPage from './pages/FiltersPage';
import EscalationsPage from './pages/EscalationsPage';
import FormsPage from './pages/FormsPage';
import MenusPage from './pages/MenusPage';
import DiagnosticPage from './pages/DiagnosticPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Shell />}>
          <Route index element={<Navigate to="/connections" replace />} />
          <Route path="connections" element={<ConnectionsPage />} />
          <Route path="activelinks" element={<ActiveLinksPage />} />
          <Route path="filters" element={<FiltersPage />} />
          <Route path="escalations" element={<EscalationsPage />} />
          <Route path="forms" element={<FormsPage />} />
          <Route path="menus" element={<MenusPage />} />
          <Route path="diagnostic" element={<DiagnosticPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
