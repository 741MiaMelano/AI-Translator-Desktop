import AppShell from "./layout/AppShell";
import AppRoutes from "./routes/AppRoutes";
import { WorkspaceProvider } from "./state/WorkspaceContext";

export default function App() {
  return (
    <WorkspaceProvider>
      <AppShell>
        <AppRoutes />
      </AppShell>
    </WorkspaceProvider>
  );
}
