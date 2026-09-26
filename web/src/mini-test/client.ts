// P1 acceptance only. No admin client, ambient Cookie or persistent token storage.
export const TEST_APP_KEY = "p1-staging-auth";
export type MiniIdentity = {
  userId: string;
  brandId: string;
  botId: string;
  expiresAt: string;
};
export class MiniTestError extends Error {
  constructor(
    public code: string,
    public status = 0,
  ) {
    super(code);
  }
}
const safeErrors = new Set([
  "mini_unauthorized",
  "mini_init_data_used",
  "mini_rate_limited",
  "mini_origin_not_allowed",
]);
export function createMiniTestClient(send: typeof fetch = fetch) {
  let token: string | undefined;
  let attempted = false;
  let busy = false;
  const call = async (
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    bearer?: string,
  ) => {
    let response: Response;
    try {
      response = await send(path, {
        method,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new MiniTestError("network_failure");
    }
    if (!response.ok) {
      const json = await response.json().catch(() => ({}));
      throw new MiniTestError(
        safeErrors.has(json.error) ? json.error : "request_rejected",
        response.status,
      );
    }
    return response.json().catch(() => {
      throw new MiniTestError("invalid_response");
    });
  };
  const me = async (): Promise<MiniIdentity> => {
    if (!token) throw new MiniTestError("not_connected");
    try {
      const data = await call("/v1/mini/me", "GET", undefined, token);
      if (
        ![data.userId, data.brandId, data.botId].every(
          (v) => typeof v === "string" && /^[a-f0-9-]{36}$/i.test(v),
        ) ||
        typeof data.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(data.expiresAt))
      )
        throw new MiniTestError("invalid_response");
      return {
        userId: data.userId,
        brandId: data.brandId,
        botId: data.botId,
        expiresAt: data.expiresAt,
      };
    } catch (e) {
      if (e instanceof MiniTestError && e.status === 401) token = undefined;
      throw e;
    }
  };
  return {
    get connected() {
      return !!token;
    },
    get attempted() {
      return attempted;
    },
    async connect(initData: string) {
      if (busy || attempted) throw new MiniTestError("reopen_required");
      if (!initData || initData.length > 16384)
        throw new MiniTestError("telegram_required");
      attempted = true;
      busy = true;
      try {
        const data = await call("/v1/mini/auth/exchange", "POST", {
          appKey: TEST_APP_KEY,
          initData,
        });
        if (
          data.tokenType !== "Bearer" ||
          typeof data.token !== "string" ||
          !/^[a-f0-9]{64}$/.test(data.token)
        )
          throw new MiniTestError("invalid_response");
        token = data.token;
        return await me();
      } finally {
        busy = false;
      }
    },
    me,
    async logout() {
      if (!token || busy) throw new MiniTestError("not_connected");
      const previous = token;
      busy = true;
      try {
        await call("/v1/mini/auth/logout", "POST", {}, previous);
        token = undefined;
        try {
          await call("/v1/mini/me", "GET", undefined, previous);
        } catch (e) {
          if (e instanceof MiniTestError && e.status === 401) return;
          throw e;
        }
        throw new MiniTestError("security_stop_session_not_revoked");
      } finally {
        busy = false;
      }
    },
    forget() {
      token = undefined;
    },
  };
}
