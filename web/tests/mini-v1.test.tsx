import { describe, it, expect, vi } from "vitest";
import { createClient } from "../src/mini/client";
const token = "a".repeat(64);
const reply = (body: unknown, status = 200, type = "application/json") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": type },
  });
describe("Mini V1 client", () => {
  it("recovers on reload before exchange, keeps credentials private and no storage", async () => {
    const store = vi.spyOn(Storage.prototype, "setItem"),
      send = vi
        .fn<typeof fetch>()
        .mockResolvedValue(reply({ token, tokenType: "Bearer" }));
    const client = createClient(send);
    await client.connect("synthetic");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("/v1/mini/auth/recover");
    expect(send.mock.calls[0][1]?.credentials).toBe("same-origin");
    expect(send.mock.calls[0][1]?.headers).toHaveProperty("X-Mini-CSRF", "1");
    expect(client).not.toHaveProperty("token");
    expect(store).not.toHaveBeenCalled();
  });
  it("uses single exchange only after rejected recovery; never blindly retries exchange", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply({}, 401))
      .mockRejectedValueOnce(new TypeError("private error"))
      .mockResolvedValueOnce(reply({}, 401));
    const c = createClient(send);
    await expect(c.connect("synthetic")).rejects.toMatchObject({
      kind: "network",
    });
    await expect(c.connect("synthetic")).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect(
      send.mock.calls.filter(([p]) => String(p).endsWith("/exchange")),
    ).toHaveLength(1);
  });
  for (const [status, kind] of [
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [429, "rate_limit"],
    [500, "server"],
  ] as const)
    it(`classifies ${status}`, async () => {
      const c = createClient(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            reply({ error: "PRIVATE_ERROR", requestId: "req-safe" }, status),
          ),
      );
      await expect(c.home()).rejects.toMatchObject({
        kind,
        status,
        requestId: "req-safe",
      });
    });
  it("separates invalid JSON, timeout, and network errors", async () => {
    await expect(
      createClient(
        vi.fn<typeof fetch>().mockResolvedValue(reply({}, 200, "text/html")),
      ).home(),
    ).rejects.toMatchObject({ kind: "invalid_json" });
    await expect(
      createClient(
        vi
          .fn<typeof fetch>()
          .mockRejectedValue(new DOMException("", "TimeoutError")),
      ).home(),
    ).rejects.toMatchObject({ kind: "timeout" });
    await expect(
      createClient(
        vi.fn<typeof fetch>().mockRejectedValue(new TypeError("secret")),
      ).home(),
    ).rejects.toMatchObject({ kind: "network" });
  });
  it("logout verifies old bearer rejection and drops in-memory identity", async () => {
    const send = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(reply({ token, tokenType: "Bearer" }))
        .mockResolvedValueOnce(reply({ ok: true }))
        .mockResolvedValueOnce(reply({}, 401)),
      c = createClient(send);
    await c.connect("synthetic");
    await c.logout();
    expect(c.connected).toBe(false);
    expect(send.mock.calls[2][1]?.headers).toHaveProperty(
      "Authorization",
      "Bearer " + token,
    );
  });
  it("missing Telegram context never sends a request", async () => {
    const send = vi.fn<typeof fetch>();
    await expect(createClient(send).connect("")).rejects.toMatchObject({
      kind: "telegram_required",
    });
    expect(send).not.toHaveBeenCalled();
  });
});
