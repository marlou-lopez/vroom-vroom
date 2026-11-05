// Setup for the jsdom (`*.test.tsx`) project.
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

// Node's fetch rejects relative URLs; the app calls `/api/...`. Resolve them against the jsdom origin.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  nativeFetch(typeof input === "string" && input.startsWith("/") ? new URL(input, window.location.origin).href : input, init)) as typeof fetch;

// jsdom lacks these; components and uPlot use them.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

// No canvas in jsdom: report "no 2D context" instead of jsdom's "not implemented" error.
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

// Radix and pointer-driven code call these.
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});
