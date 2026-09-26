import React from "react";
import { afterEach, it, expect, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PlatformAccounts from "../src/mini/PlatformAccounts";
import PlatformCenter from "../src/platforms/PlatformCenter";
import { MiniError, type MiniClient } from "../src/mini/client";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const identity = {
  id: "internal-identity",
  platformId: "platform",
  platformName: "FUN66",
  uidMasked: "BR****01",
  status: "pending" as const,
  submittedAt: new Date().toISOString(),
  verifiedAt: null,
};
function client() {
  let current: typeof identity | null = null;
  return {
    platforms: vi.fn(async () => ({
      items: [
        {
          id: "platform",
          display_name: "FUN66",
          code: "TEST",
          status: "active",
          verification_method: "manual_admin",
          identity: current,
        },
      ],
    })),
    identities: vi.fn(async () => ({
      items: current ? [current] : [],
      nextCursor: null,
    })),
    submitPlatform: vi.fn(async () => {
      current = identity;
      return identity;
    }),
  };
}
it("Mini submit shows pending, masked UID and no internal identifiers; refresh picks up verified", async () => {
  const c = client(),
    u = userEvent.setup();
  render(
    <PlatformAccounts client={c as unknown as MiniClient} locale="zh-CN" />,
  );
  await u.click(await screen.findByRole("button", { name: "绑定账号" }));
  await u.type(screen.getByRole("textbox"), "BRTEST10001");
  await u.click(screen.getByRole("button", { name: "提交验证" }));
  await waitFor(() => expect(c.submitPlatform).toHaveBeenCalledOnce());
  expect(c.submitPlatform.mock.calls[0]).toEqual([
    "platform",
    "BRTEST10001",
    expect.any(String),
  ]);
  await screen.findAllByText("待验证");
  expect(document.body.textContent).not.toContain("BRTEST10001");
  expect(document.body.textContent).not.toContain("internal-identity");
  expect(screen.queryByRole("textbox")).toBeNull();
});
it("network retry retains idempotency key and English uses translated labels", async () => {
  const c = client();
  c.submitPlatform.mockRejectedValueOnce(new MiniError("network"));
  const u = userEvent.setup();
  render(<PlatformAccounts client={c as unknown as MiniClient} locale="en" />);
  await u.click(await screen.findByRole("button", { name: "Bind account" }));
  await u.type(screen.getByRole("textbox"), "BRTEST10001");
  await u.click(
    screen.getByRole("button", { name: "Submit for verification" }),
  );
  await screen.findByRole("alert");
  await u.click(
    screen.getByRole("button", { name: "Submit for verification" }),
  );
  await waitFor(() => expect(c.submitPlatform).toHaveBeenCalledTimes(2));
  expect(c.submitPlatform.mock.calls[0]).toEqual(
    c.submitPlatform.mock.calls[1],
  );
});
it("admin without review permission cannot expose full UID or perform review", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [{ ...identity, userId: "user" }],
            nextCursor: null,
          }),
          { status: 200 },
        ),
    ),
  );
  render(
    <PlatformCenter
      base="/scope"
      mode="identities"
      permissions={["platform_identities.read"]}
      csrf="test"
      onExpire={() => {}}
    />,
  );
  await screen.findByText("BR****01");
  expect(screen.queryByRole("button", { name: "审核详情" })).toBeNull();
  expect(document.body.textContent).not.toContain("BRTEST10001");
});
it("admin reads UID only in explicit review detail and sends evidence + existing CSRF", async () => {
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/review"))
      return new Response(JSON.stringify({ ...identity, status: "verified" }));
    return new Response(
      JSON.stringify(
        String(url).endsWith("/internal-identity")
          ? { ...identity, uid: "BRTEST10001" }
          : { items: [{ ...identity, userId: "user" }], nextCursor: null },
      ),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const u = userEvent.setup();
  render(
    <PlatformCenter
      base="/scope"
      mode="identities"
      permissions={["platform_identities.read", "platform_identities.verify"]}
      csrf="csrf-test"
      onExpire={() => {}}
    />,
  );
  await u.click(await screen.findByRole("button", { name: "审核详情" }));
  await screen.findByText("BRTEST10001");
  expect(
    (screen.getByRole("button", { name: "验证通过" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await u.type(screen.getByLabelText("验证证据编号"), "CASE-TEST");
  await u.click(screen.getByRole("button", { name: "验证通过" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) => String(url).endsWith("/review")),
    ).toBe(true),
  );
  const call = fetcher.mock.calls.find(([url]) =>
    String(url).endsWith("/review"),
  )!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({
    action: "verify",
    evidenceReference: "CASE-TEST",
  });
  expect(call[1]!.headers).toMatchObject({ "X-CSRF-Token": "csrf-test" });
});
