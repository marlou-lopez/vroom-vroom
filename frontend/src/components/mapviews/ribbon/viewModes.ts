// Kept apart from cameraRigs.ts so the view can list the modes without importing three.js (which loads lazily).

/** Cameras the ribbon view can use. */
export type ViewMode = "chase" | "cockpit" | "orbit" | "top";
export const VIEW_MODES: readonly ViewMode[] = ["chase", "cockpit", "orbit", "top"];
