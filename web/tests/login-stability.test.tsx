import { afterEach, describe, it, expect, vi } from "vitest";
import { request, json, ApiError } from "../src/api";
import { createClient } from "../src/mini/client";
afterEach(() => vi.unstubAllGlobals());
const response = (status: number, html = false) =>
  new Response(
    html
      ? "<html>gateway failure</html>"
      : JSON.stringify({
          error: status === 403 ? "csrf_failed" : "upstream_unavailable",
        }),
    {
      status,
      headers: { "content-type": html ? "text/html" : "application/json" },
    },
  );
describe("login transport failure boundaries", () => {
  for (const status of [502, 503, 504])
    for (const html of [false, true]) {
      it(`Admin ${status} ${html ? "HTML" : "JSON"} is unavailable and POST is sent once`, async () => {
        const send = vi.fn(async () => response(status, html));
        vi.stubGlobal("fetch", send);
        await expect(
          request(
            "/v1/auth/login",
            json({ login: "synthetic", password: "synthetic" }),
          ),
        ).rejects.toThrow("服务暂时无法连接");
        expect(send).toHaveBeenCalledTimes(1);
      });
      it(`Mini ${status} ${html ? "HTML" : "JSON"} can recover on explicit reconnect without exchange replay`, async () => {
        const send = vi
          .fn()
          .mockResolvedValueOnce(response(status, html))
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({ tokenType: "Bearer", token: "a".repeat(64) }),
              { headers: { "content-type": "application/json" } },
            ),
          );
        const client = createClient(send);
        await expect(client.connect("synthetic")).rejects.toMatchObject({
          kind: "service_unavailable",
          status,
        });
        expect(send).toHaveBeenCalledTimes(1);
        await client.connect("synthetic");
        expect(client.connected).toBe(true);
        expect(send.mock.calls.map((c) => c[0])).toEqual([
          "/v1/mini/auth/recover",
          "/v1/mini/auth/recover",
        ]);
      });
    }
  for (const status of [401, 403, 500])
    it(`Admin preserves ${status} as distinct failure`, async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response(status)),
      );
      try {
        await request("/v1/auth/login", json({}));
        throw Error("unexpected success");
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).status).toBe(status);
        expect((e as Error).message).not.toContain("可能正在启动");
      }
    });
  it("Admin manual reconnect uses GET only and may recover after gateway failure", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(502, true))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ displayName: "synthetic" })),
      );
    vi.stubGlobal("fetch", send);
    await expect(request("/v1/me")).rejects.toThrow("服务暂时无法连接");
    await expect(request("/v1/me")).resolves.toEqual({
      displayName: "synthetic",
    });
    expect(send.mock.calls.every((c) => !c[1].method)).toBe(true);
  });
});
