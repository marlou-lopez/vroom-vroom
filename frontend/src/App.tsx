import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { SessionsPage } from "./pages/SessionsPage";
import { TelemetryPage } from "./pages/TelemetryPage";
import { TracksPage } from "./pages/TracksPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<TelemetryPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="tracks" element={<TracksPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
