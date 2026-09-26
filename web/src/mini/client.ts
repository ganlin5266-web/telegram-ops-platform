export type Failure =
  | "network"
  | "timeout"
  | "invalid_json"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limit"
  | "server"
  | "request"
  | "telegram_required";
export class MiniError extends Error {
  constructor(
    public kind: Failure,
    public status = 0,
    public requestId?: string,
  ) {
    super(kind);
  }
}
export type Home = {
  profile: {
    displayName: string;
    projectName: string;
    botName: string;
    uiLanguage: string;
  };
  points: { accountExists: boolean; balance: string | null };
  invitedCount: string;
  redemptionCount: string;
  activities: { participationEnabled: boolean };
};
export type Row = {
  id: string;
  created_at: string;
  delta?: string;
  source?: string;
  business_type?: string;
  status?: string;
  reward_status?: string;
  points_cost?: string;
};
export type Page = { items: Row[]; nextCursor: string | null };
const APP_KEY = "p1-staging-auth";
export function createClient(send: typeof fetch = fetch) {
  let token: string | undefined,
    attempted = false;
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    bearer = token,
    cookies = false,
  ): Promise<any> {
    let r: Response;
    try {
      r = await send("/v1/mini" + path, {
        method,
        credentials: cookies ? "same-origin" : "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(cookies ? { "X-Mini-CSRF": "1" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new MiniError(
        !!e &&
          typeof e === "object" &&
          "name" in e &&
          ["TimeoutError", "AbortError"].includes(String(e.name))
          ? "timeout"
          : "network",
      );
    }
    let json: any;
    try {
      if (!r.headers.get("content-type")?.includes("application/json"))
        throw Error();
      json = await r.json();
    } catch {
      throw new MiniError("invalid_json", r.status);
    }
    if (!r.ok) {
      const id =
        typeof json.requestId === "string" &&
        /^[\w-]{1,100}$/.test(json.requestId)
          ? json.requestId
          : undefined;
      if (r.status === 401) token = undefined;
      throw new MiniError(
        (
          {
            401: "unauthorized",
            403: "forbidden",
            404: "not_found",
            409: "conflict",
            429: "rate_limit",
          } as Record<number, Failure>
        )[r.status] ?? (r.status >= 500 ? "server" : "request"),
        r.status,
        id,
      );
    }
    return json;
  }
  function accept(data: any) {
    if (
      data.tokenType !== "Bearer" ||
      typeof data.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(data.token)
    )
      throw new MiniError("invalid_json");
    token = data.token;
  }
  return {
    get connected() {
      return !!token;
    },
    async connect(raw: string) {
      if (!raw || raw.length > 16384) throw new MiniError("telegram_required");
      // Recovery may safely repeat: it creates no new session and never extends expiry.
      try {
        accept(
          await call(
            "/auth/recover",
            "POST",
            { appKey: APP_KEY, initData: raw },
            undefined,
            true,
          ),
        );
        return;
      } catch (e) {
        if (!(e instanceof MiniError) || e.status !== 401) throw e;
      }
      if (attempted) throw new MiniError("unauthorized");
      attempted = true;
      accept(
        await call(
          "/auth/exchange",
          "POST",
          { appKey: APP_KEY, initData: raw, recovery: true },
          undefined,
          true,
        ),
      );
    },
    home: () => call("/home") as Promise<Home>,
    page: (
      kind: "point-ledger" | "referrals" | "redemptions",
      cursor?: string,
    ) =>
      call(
        "/" + kind + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      ) as Promise<Page>,
    async logout() {
      const old = token;
      if (!old) throw new MiniError("unauthorized");
      await call("/auth/logout", "POST", {}, old, true);
      token = undefined;
      try {
        await call("/me", "GET", undefined, old);
      } catch (e) {
        if (e instanceof MiniError && e.status === 401) return;
        throw e;
      }
      throw new MiniError("server");
    },
    forget() {
      token = undefined;
    },
  };
}
