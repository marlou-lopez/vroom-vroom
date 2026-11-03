import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import App from "./App.tsx";
import { ApiError } from "./api/types";
import { applyThemeVariables } from "./theme";

// Tokens from theme.ts become CSS custom properties on :root; index.css and the CSS Modules read them with var(--…).
applyThemeVariables();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // One retry, but only for failures that may be transient: an ApiError other than "network" is the server's answer.
      retry: (count, error) => count < 1 && !(error instanceof ApiError && error.code !== "network"),
      refetchOnWindowFocus: false,
    },
  },
});

/** With VITE_API=mock a service worker (MSW) answers /api/*; it must be up before the first request. */
async function enableMocking() {
  if (import.meta.env.VITE_API !== "mock") return;
  const { worker } = await import("./api/mock/browser");
  await worker.start({ onUnhandledRequest: "bypass" });
}

void enableMocking().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
});
