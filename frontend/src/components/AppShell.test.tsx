import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell";

describe("AppShell header", () => {
  it("has no page navigation, only the brand link home (the scope line navigates)", () => {
    render(
      <MemoryRouter initialEntries={["/?lap=a"]}>
        <Routes><Route element={<AppShell />}><Route path="*" element={null} /></Route></Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Tracks" })).toBeNull();
    expect(screen.getByRole("link", { name: "RACECOACH" }).getAttribute("href")).toBe("/");
  });
});
