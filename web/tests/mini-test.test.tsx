import { describe, it, expect, vi } from "vitest";
import { createMiniTestClient, TEST_APP_KEY } from "../src/mini-test/client";
const identity = {
  userId: "11111111-1111-4111-8111-111111111111",
  brandId: "22222222-2222-4222-8222-222222222222",
  botId: "33333333-3333-4333-8333-333333333333",
  expiresAt: "2030-01-01T00:00:00.000Z",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function setup() {
  const token = "a".repeat(64);
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(reply({ token, tokenType: "Bearer" }))
    .mockResolvedValueOnce(reply(identity));
  return { token, send, client: createMiniTestClient(send) };
}
describe("P1 staging acceptance client", () => {
  it("exchanges raw initData only with the fixed public selector; no admin Cookie", async () => {
    const { send, client } = setup();
    expect(await client.connect("synthetic-init-data")).toEqual(identity);
    expect(send.mock.calls[0][0]).toBe("/v1/mini/auth/exchange");
    expect(JSON.parse(String(send.mock.calls[0][1]?.body))).toEqual({
      appKey: TEST_APP_KEY,
      initData: "synthetic-init-data",
    });
    for (const [, options] of send.mock.calls) {
      expect(options?.credentials).toBe("omit");
      expect(options?.cache).toBe("no-store");
      expect(options?.redirect).toBe("error");
    }
    expect(send.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
    expect(send.mock.calls[1][0]).toBe("/v1/mini/me");
    expect(client).not.toHaveProperty("token");
  });
  it("refuses empty initData without requests", async () => {
    const { client, send } = setup();
    await expect(client.connect("")).rejects.toMatchObject({
      code: "telegram_required",
    });
    expect(send).not.toHaveBeenCalled();
  });
  it("does not repeat exchange", async () => {
    const { client, send } = setup();
    await client.connect("synthetic");
    await expect(client.connect("synthetic")).rejects.toMatchObject({
      code: "reopen_required",
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("does not automatically retry a lost exchange response", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("sensitive upstream text"));
    const client = createMiniTestClient(send);
    await expect(client.connect("synthetic")).rejects.toMatchObject({
      code: "network_failure",
    });
    await expect(client.connect("synthetic")).rejects.toMatchObject({
      code: "reopen_required",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("refresh starts without a token even if another instance connected", async () => {
    const { client, send } = setup();
    await client.connect("synthetic");
    await expect(createMiniTestClient(send).me()).rejects.toMatchObject({
      code: "not_connected",
    });
  });
  it("does not persist bearer or initialization data", async () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    const { client } = setup();
    await client.connect("synthetic");
    expect(local).not.toHaveBeenCalled();
  });
  it("logout verifies the revoked token produces 401 then forgets it", async () => {
    const { client, send, token } = setup();
    await client.connect("synthetic");
    send
      .mockResolvedValueOnce(reply({ ok: true }))
      .mockResolvedValueOnce(reply({ error: "mini_unauthorized" }, 401));
    await client.logout();
    expect(client.connected).toBe(false);
    expect(send.mock.calls[2][0]).toBe("/v1/mini/auth/logout");
    expect(send.mock.calls[3][1]?.headers).toHaveProperty(
      "Authorization",
      `Bearer ${token}`,
    );
    await expect(client.me()).rejects.toMatchObject({ code: "not_connected" });
  });
  it("raises a safety failure if a revoked session is accepted", async () => {
    const { client, send } = setup();
    await client.connect("synthetic");
    send
      .mockResolvedValueOnce(reply({ ok: true }))
      .mockResolvedValueOnce(reply(identity));
    await expect(client.logout()).rejects.toMatchObject({
      code: "security_stop_session_not_revoked",
    });
    expect(client.connected).toBe(false);
  });
  it("retains session on failed logout, never claims revocation", async () => {
    const { client, send } = setup();
    await client.connect("synthetic");
    send.mockRejectedValueOnce(new Error("connection"));
    await expect(client.logout()).rejects.toMatchObject({
      code: "network_failure",
    });
    expect(client.connected).toBe(true);
  });
  it("clears the token after /me rejects it", async () => {
    const { client, send } = setup();
    await client.connect("synthetic");
    send.mockResolvedValueOnce(reply({ error: "mini_unauthorized" }, 401));
    await expect(client.me()).rejects.toMatchObject({ status: 401 });
    expect(client.connected).toBe(false);
  });
  it("never exposes raw upstream errors", async () => {
    const client = createMiniTestClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(reply({ error: "secret-content" }, 500)),
    );
    await expect(client.connect("synthetic")).rejects.toMatchObject({
      code: "request_rejected",
    });
  });
  it("rejects malformed token responses", async () => {
    const client = createMiniTestClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(reply({ token: "bad", tokenType: "Bearer" })),
    );
    await expect(client.connect("synthetic")).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(client.connected).toBe(false);
  });
  it("forgets memory session on page exit", async () => {
    const { client } = setup();
    await client.connect("synthetic");
    client.forget();
    expect(client.connected).toBe(false);
  });
});
