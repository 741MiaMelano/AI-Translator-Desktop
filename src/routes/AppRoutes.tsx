import { Navigate, Route, Routes } from "react-router-dom";
import StartTranslatePage from "../pages/StartTranslatePage";
import BatchProcessPage from "../pages/BatchProcessPage";
import TaskCenterPage from "../pages/TaskCenterPage";
import SubtitleEditorPage from "../pages/SubtitleEditorPage";
import ModelApiPage from "../pages/ModelApiPage";
import TermsStylePage from "../pages/TermsStylePage";
import SettingsPage from "../pages/SettingsPage";
import ProjectOverviewPage from "../pages/ProjectOverviewPage";
import MediaToolsPage from "../pages/MediaToolsPage";

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<StartTranslatePage />} />
      <Route path="/batch/review" element={<BatchProcessPage />} />
      <Route path="/workspace" element={<TaskCenterPage />} />
      <Route path="/projects/:projectId" element={<ProjectOverviewPage />} />
      <Route path="/projects/:projectId/editor/:targetLanguage" element={<SubtitleEditorPage />} />
      <Route path="/library" element={<TermsStylePage />} />
      <Route path="/media-tools" element={<MediaToolsPage />} />
      <Route path="/capabilities" element={<ModelApiPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/batch" element={<Navigate to="/batch/review" replace />} />
      <Route path="/start" element={<Navigate to="/" replace />} />
      <Route path="/tasks" element={<Navigate to="/workspace" replace />} />
      <Route path="/models" element={<Navigate to="/capabilities" replace />} />
      <Route path="/terms" element={<Navigate to="/library" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
