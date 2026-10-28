export type Failure =
  | "service_unavailable"
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
    public code?: string,
  ) {
    super(kind);
  }
}
export type MemberSummary = {
  enabled: boolean;
  available: boolean;
  level?: number;
  levelName?: string;
  growth?: string;
  progress?: number;
  nextThreshold?: string | null;
  protected?: boolean;
  todayGrowth?: string;
  dailyCap?: number;
  actualGrowthEarned?: string | null;
  nextAvailableAt?: string | null;
  businessTimezone?: string;
  businessDate?: string;
  checkinReward?: string | null;
  checkinStatus?: "available" | "checked_in" | "cap_reached" | "unavailable";
  canCheckin?: boolean;
  todayCheckedIn?: boolean;
  todayCheckinAvailable?: boolean;
};
// BACKEND_PENDING (proposed, optional): see BACKEND_API_REQUIREMENTS.md.
export type ReferralSummary = {
  platformId?: string;
  businessDate?: string;
  businessTimezone?: string;
  rewardedToday?: string;
  pendingCount?: string;
  capExceededCount?: string;
  dailyCap?: number;
  activity?: {
    inviterPoints: string;
    inviteePoints: string;
    inviteeEnabled: boolean;
  } | null;
  rewardEligible?: boolean;
  rewardAvailability?:
    | "available"
    | "disabled"
    | "out_of_scope"
    | "no_activity"
    | "member_required";
  qualifiedToday?: string;
  dailyRewardLimit?: string;
  qualifiedTotal?: string;
  pointsEarned?: string;
  /** Legacy optional field kept for an older presentation contract. */
  growthEarned?: string;
  remainingRewardChances?: string;
  shareUrl?: string | null;
};
export type PrimaryAction = {
  kind:
    | "view_code"
    | "redeem"
    | "bind_uid"
    | "view_identity"
    | "checkin"
    | "invite"
    | "view_records";
  platformId?: string;
  orderId?: string;
  ruleId?: string;
};
export type HomePlatform = {
  id: string;
  displayName: string;
  timezone: string;
};
export type Home = {
  platforms?: HomePlatform[];
  currentPlatform?: HomePlatform | null;
  identity?: {
    status:
      "unbound" | "pending" | "verified" | "rejected" | "conflict" | "revoked";
  };
  recommendedRedemption?: RedemptionTier | null;
  recentOrders?: Row[];
  member?: MemberSummary;
  profile: {
    displayName: string;
    projectName: string;
    botName: string;
    uiLanguage: string;
    preferredLanguage?: string | null;
    botLanguage?: string;
    projectLanguage?: string;
    telegramLanguage?: string | null;
  };
  points: {
    accountExists: boolean;
    balance: string | null;
    expiringSoon?: string;
  };
  invitedCount: string;
  redemptionCount: string;
  activities: { participationEnabled: boolean };
  referral?: ReferralSummary;
  primaryAction?: PrimaryAction | null;
};
export type Row = {
  id: string;
  created_at: string;
  delta?: string;
  source?: string;
  business_type?: string;
  status?: string;
  reward_status?: string;
  displayStatus?: "pending" | "rewarded" | "cap_exceeded" | "review_required";
  points_cost?: string;
};
export type Page = { items: Row[]; nextCursor: string | null };
export type RedemptionTier = {
  id: string;
  platform_id: string;
  tier_key: string;
  name: string;
  points_cost: string;
  face_value: string;
  face_currency: string;
  display_name: string;
  redemption_url: string | null;
  available: number;
  balance?: string | null;
  pointsGap?: string | null;
  canRedeem?: boolean;
  unavailableReason?: string | null;
  usedToday?: number;
  pointsUsedToday?: string;
  dailyCountLimit?: number;
  dailyPointsLimit?: string;
};
export type RedemptionReveal = {
  id: string;
  status: string;
  code: string;
  pointsCost: string;
  platformId: string;
  tierKey: string;
  faceValue: string;
  faceCurrency: string;
  redemptionUrl: string | null;
  businessDate: string;
  claimedAt: string | null;
};
export function createClient(send: typeof fetch = fetch) {
  let token: string | undefined,
    attempted = false;
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    bearer = token,
    cookies = false,
    extraHeaders: Record<string, string> = {},
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
          ...extraHeaders,
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
    // Classify gateway failures before JSON parsing; never expose HTML or retry a POST.
    if ([502, 503, 504].includes(r.status))
      throw new MiniError("service_unavailable", r.status);
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
        typeof json.error === "string" && /^[a-z_]{1,80}$/.test(json.error)
          ? json.error
          : undefined,
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
            { initData: raw },
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
          { initData: raw, recovery: true },
          undefined,
          true,
        ),
      );
    },
    platformDataStatus: () =>
      call("/platform-data-status") as Promise<{
        items: {
          platformId: string;
          latestDate: string | null;
          status: string;
        }[];
      }>,
    platforms: () => call("/platforms") as Promise<{ items: MiniPlatform[] }>,
    identities: (cursor?: string) =>
      call(
        "/platform-identities" +
          (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      ) as Promise<{ items: PlatformIdentity[]; nextCursor: string | null }>,
    submitPlatform: (platformId: string, uid: string, key: string) =>
      call("/platform-identities", "POST", { platformId, uid }, token, false, {
        "X-Mini-CSRF": "1",
        "Idempotency-Key": key,
      }) as Promise<PlatformIdentity>,
    memberHistory: (after?: string) =>
      call(
        "/member/growth" + (after ? "?after=" + encodeURIComponent(after) : ""),
      ),
    memberCheckin: () => call("/member/checkin", "POST", {}),
    redemptionTiers: (platformId?: string) =>
      call(
        "/redemption-tiers" +
          (platformId ? "?platformId=" + encodeURIComponent(platformId) : ""),
      ) as Promise<{ items: RedemptionTier[] }>,
    createRedemption: (ruleId: string, key: string) =>
      call("/redemption-orders", "POST", { ruleId }, token, false, {
        "X-Mini-CSRF": "1",
        "Idempotency-Key": key,
      }) as Promise<{ id: string; status: string; points_cost: string }>,
    claimRedemption: (id: string) =>
      call(
        `/redemption-orders/${encodeURIComponent(id)}/claim`,
        "POST",
        {},
        token,
        false,
        { "X-Mini-CSRF": "1" },
      ) as Promise<RedemptionReveal>,
    redemptionCode: (id: string) =>
      call(
        `/redemption-orders/${encodeURIComponent(id)}/code`,
      ) as Promise<RedemptionReveal>,
    home: (platformId?: string) =>
      call(
        "/home" +
          (platformId ? "?platformId=" + encodeURIComponent(platformId) : ""),
      ) as Promise<Home>,
    page: (
      kind: "point-ledger" | "referrals" | "redemptions",
      cursor?: string,
      platformId?: string,
    ) =>
      call(
        "/" +
          kind +
          (cursor || (kind === "referrals" && platformId)
            ? "?" +
              new URLSearchParams({
                ...(cursor ? { cursor } : {}),
                ...(kind === "referrals" && platformId ? { platformId } : {}),
              }).toString()
            : ""),
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

export type PlatformIdentity = {
  id: string;
  platformId: string;
  platformName: string;
  uidMasked: string;
  status: "pending" | "verified" | "rejected" | "conflict" | "revoked";
  submittedAt: string;
  verifiedAt: string | null;
};
export type MiniPlatform = {
  id: string;
  display_name: string;
  code: string;
  status: string;
  verification_method: string;
  uid_format: string;
  uid_min_length: number;
  uid_max_length: number;
  identity: PlatformIdentity | null;
};
export type MiniClient = ReturnType<typeof createClient>;
