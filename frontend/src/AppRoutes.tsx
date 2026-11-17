import { Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { NotFoundPage } from "./pages/NotFoundPage";
import { SessionsPage } from "./pages/SessionsPage";
import { TelemetryPage } from "./pages/TelemetryPage";
import { TracksPage } from "./pages/TracksPage";

/** The route table. Separate from `App` so tests can mount it under a MemoryRouter. */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<TelemetryPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="tracks" element={<TracksPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
