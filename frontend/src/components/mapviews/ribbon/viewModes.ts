// Kept apart from cameraRigs.ts so the view can list the modes without importing three.js (which loads lazily).

/** Cameras the ribbon view can use. A future "cockpit" id joins here (see CameraFrame.eye in cameraRigs.ts). */
export type ViewMode = "chase" | "orbit" | "top";
export const VIEW_MODES: readonly ViewMode[] = ["chase", "orbit", "top"];
