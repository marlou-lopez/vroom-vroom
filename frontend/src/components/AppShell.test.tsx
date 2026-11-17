import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell";

describe("AppShell header navigation", () => {
  it("keeps the query string on every nav link", () => {
    render(
      <MemoryRouter initialEntries={["/?lap=a&at=300&debug=1&balance"]}>
        <Routes><Route element={<AppShell />}><Route path="*" element={null} /></Route></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Sessions" }).getAttribute("href")).toBe("/sessions?lap=a&debug=1&balance=");
    expect(screen.getByRole("link", { name: "Tracks" }).getAttribute("href")).toBe("/tracks?lap=a&debug=1&balance=");
  });
});
