import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { AppLayout } from './layout.js';
import { ActivityPage } from '../pages/ActivityPage.js';
import { ArchivePortalPage } from '../pages/ArchivePortalPage.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { StatusPage } from '../pages/StatusPage.js';
import { ArchivedDetailPage, ArchivedPage } from '../pages/ArchivedPage.js';
import { FilesPage } from '../pages/FilesPage.js';
import { LabPage } from '../pages/LabPage.js';
import { PoliciesPage } from '../pages/PoliciesPage.js';
import { PolicyEditorPage } from '../pages/PolicyEditorPage.js';
import { RunDetailPage } from '../pages/RunDetailPage.js';
import { SiteDetailPage } from '../pages/SiteDetailPage.js';
import { SitesPage } from '../pages/SitesPage.js';

function RedirectWithSearch({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate to={`${to}${location.search}${location.hash}`} replace />;
}

function RedirectSitioDetail() {
  const { id } = useParams();
  return <Navigate to={`/sites/${id ?? ''}`} replace />;
}

function RedirectArchivingDetail() {
  const { id } = useParams();
  return <Navigate to={`/archived/${id ?? ''}`} replace />;
}

function RedirectPoliticaEditor() {
  const { id } = useParams();
  return <Navigate to={`/policies/${id ?? ''}`} replace />;
}

function RedirectCorridaDetail() {
  const { id } = useParams();
  return <Navigate to={`/runs/${id ?? ''}`} replace />;
}

function RedirectArchivoPortal() {
  const { id } = useParams();
  return <Navigate to={`/archive/${id ?? ''}`} replace />;
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="archivo/:id" element={<RedirectArchivoPortal />} />
        <Route path="archive/:id" element={<ArchivePortalPage />} />

        <Route element={<AppLayout />}>
          <Route index element={<StatusPage />} />
          <Route path="sites" element={<SitesPage />} />
          <Route path="sitios" element={<Navigate to="/sites" replace />} />
          <Route path="sitios/:id" element={<RedirectSitioDetail />} />
          <Route path="sites/:id" element={<SiteDetailPage />} />
          <Route path="files" element={<FilesPage />} />
          <Route path="archivos" element={<Navigate to="/files" replace />} />
          <Route path="policies" element={<PoliciesPage />} />
          <Route path="politicas" element={<Navigate to="/policies" replace />} />
          <Route path="policies/new" element={<PolicyEditorPage />} />
          <Route path="politicas/nueva" element={<Navigate to="/policies/new" replace />} />
          <Route path="policies/:id" element={<PolicyEditorPage />} />
          <Route path="politicas/:id" element={<RedirectPoliticaEditor />} />
          <Route path="lab" element={<LabPage />} />
          <Route path="laboratorio" element={<Navigate to="/lab" replace />} />
          <Route path="runs/:id" element={<RunDetailPage />} />
          <Route path="corridas/:id" element={<RedirectCorridaDetail />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="actividad" element={<RedirectWithSearch to="/activity" />} />
          <Route path="archived" element={<ArchivedPage />} />
          <Route path="archivados" element={<Navigate to="/archived" replace />} />
          <Route path="archived/:id" element={<ArchivedDetailPage />} />
          <Route path="archivados/:id" element={<RedirectArchivingDetail />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
