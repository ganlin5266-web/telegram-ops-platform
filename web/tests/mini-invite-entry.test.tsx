import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MiniApp } from "../src/mini/main";
const home = {
  profile: { displayName: "Test", preferredLanguage: "en" },
  points: { accountExists: true, balance: "0" },
  invitedCount: "0",
  redemptionCount: "0",
  activities: { participationEnabled: false },
  primaryAction: { kind: "bind_uid" },
};
function client() {
  return {
    connected: false,
    connect: vi.fn(async () => {}),
    home: vi.fn(async () => home),
    page: vi.fn(async () => ({ items: [], nextCursor: null })),
    forget: vi.fn(),
    logout: vi.fn(),
    redemptionTiers: vi.fn(async () => ({ items: [] })),
  } as any;
}
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
});
it("trusted Bot invitation navigation waits for auth and ignores client scope hints", async () => {
  window.history.replaceState(
    {},
    "",
    "/mini.html?view=invite&botId=untrusted&brandId=untrusted",
  );
  const c = client();
  render(<MiniApp client={c} />);
  await waitFor(() =>
    expect(c.page).toHaveBeenCalledWith("referrals", undefined, undefined),
  );
  expect(c.connect).toHaveBeenCalledWith("");
  expect(c.home).toHaveBeenCalledWith(undefined);
  expect(c.connect.mock.invocationCallOrder[0]).toBeLessThan(
    c.page.mock.invocationCallOrder[0],
  );
  await screen.findByRole("heading", { name: "Invitation history" });
});
it("unknown view is ignored, retains one home recommendation without fetching arbitrary records", async () => {
  window.history.replaceState({}, "", "/mini.html?view=admin");
  const c = client();
  render(<MiniApp client={c} />);
  await waitFor(() => expect(c.home).toHaveBeenCalled());
  expect(c.page).not.toHaveBeenCalled();
});
it("failed authentication never requests invitation data", async () => {
  window.history.replaceState({}, "", "/mini.html?view=invite");
  const c = client();
  c.connect = vi.fn(async () => {
    throw Error("denied");
  });
  render(<MiniApp client={c} />);
  await waitFor(() => expect(c.connect).toHaveBeenCalled());
  expect(c.home).not.toHaveBeenCalled();
  expect(c.page).not.toHaveBeenCalled();
});
