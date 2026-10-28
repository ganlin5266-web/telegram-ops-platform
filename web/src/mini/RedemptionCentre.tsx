import { useEffect, useRef, useState } from "react";
import {
  MiniError,
  type MiniClient,
  type RedemptionReveal,
  type RedemptionTier,
} from "./client";
import type { Key, Locale } from "./i18n";
import { formatPoints } from "./i18n";
const reasonKeys: Record<string, Key> = {
  insufficient_available_points: "p0InsufficientPoints",
  insufficient_points: "p0InsufficientPoints",
  insufficient_balance: "p0InsufficientPoints",
  inventory_empty: "p0InsufficientStock",
  daily_redemption_limit: "p0DailyLimit",
  redemption_code_unavailable: "p0CodeUnavailable",
  invalid_order_state: "p0OrderProcessing",
  member_unavailable: "p0Unavailable",
  account_unavailable: "p0Unavailable",
  redemption_rule_unsupported: "p0Unavailable",
};
export function redemptionErrorKey(error: unknown): Key {
  if (error instanceof MiniError)
    return (error.code && reasonKeys[error.code]) || error.kind;
  return "redeemRetrySafe";
}
function safePlatformUrl(url?: string | null) {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}
export default function RedemptionCentre({
  client,
  locale,
  t,
  onChanged,
  recoverId,
  platformId,
  onOrders,
}: {
  client: MiniClient;
  locale: Locale;
  t: (key: Key, values?: Record<string, string>) => string;
  onChanged: () => Promise<unknown>;
  recoverId?: string;
  platformId?: string;
  onOrders?: () => void;
}) {
  const [tiers, setTiers] = useState<RedemptionTier[]>([]),
    [reveal, setReveal] = useState<RedemptionReveal>();
  const [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [failed, setFailed] = useState(false),
    [notice, setNotice] = useState("");
  const [pendingOrder, setPendingOrder] = useState<string>();
  const keys = useRef(new Map<string, string>()),
    assigned = useRef(new Map<string, string>()),
    inflight = useRef(false);
  const loadTiers = async () => {
    const r = await client.redemptionTiers(platformId);
    setTiers(r.items);
    setLoaded(true);
  };
  useEffect(() => {
    let live = true;
    setLoaded(false);
    setFailed(false);
    setTiers([]);
    setReveal(undefined);
    setNotice("");
    setPendingOrder(undefined);
    client
      .redemptionTiers(platformId)
      .then((r) => {
        if (live) {
          setTiers(r.items);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (live) {
          setFailed(true);
          setNotice(t(redemptionErrorKey(e)));
        }
      });
    return () => {
      live = false;
    };
  }, [client, platformId]);
  useEffect(() => {
    if (!recoverId) return;
    let live = true;
    setBusy(true);
    setNotice("");
    setReveal(undefined);
    client
      .redemptionCode(recoverId)
      .then((r) => {
        if (live) {
          setReveal(r);
          setPendingOrder(undefined);
        }
      })
      .catch((e) => live && setNotice(t(redemptionErrorKey(e))))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [client, recoverId]);
  const redeem = async (tier: RedemptionTier) => {
    if (inflight.current || tier.canRedeem !== true) return;
    if (!window.confirm(t("redeemConfirm", { points: tier.points_cost })))
      return;
    inflight.current = true;
    setBusy(true);
    setNotice("");
    try {
      const key = keys.current.get(tier.id) ?? crypto.randomUUID();
      keys.current.set(tier.id, key);
      let orderId = assigned.current.get(tier.id);
      if (!orderId) {
        const order = await client.createRedemption(tier.id, key);
        orderId = order.id;
        assigned.current.set(tier.id, order.id);
      }
      setPendingOrder(orderId);
      const result = await client.claimRedemption(orderId);
      keys.current.delete(tier.id);
      assigned.current.delete(tier.id);
      setPendingOrder(undefined);
      setReveal(result);
      await onChanged();
      await loadTiers();
    } catch (e) {
      setNotice(t(redemptionErrorKey(e)));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };
  const recover = async (id: string) => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setNotice("");
    try {
      setReveal(await client.redemptionCode(id));
      setPendingOrder(undefined);
    } catch (e) {
      setNotice(t(redemptionErrorKey(e)));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };
  const claim = async () => {
    if (!reveal || inflight.current) return;
    inflight.current = true;
    setBusy(true);
    try {
      setReveal(await client.claimRedemption(reveal.id));
      await onChanged();
      await loadTiers();
    } catch (e) {
      setNotice(t(redemptionErrorKey(e)));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!reveal) return;
    try {
      await navigator.clipboard.writeText(reveal.code);
      setNotice(t("codeCopied"));
    } catch {
      setNotice(t("p0CodeCopyFailed"));
    }
  };
  return (
    <section className="card redemption-centre">
      <h2>{t("redeemCentre")}</h2>
      {!loaded && !failed && <p role="status">{t("loading")}</p>}
      {loaded && !tiers.length && <p className="muted">{t("redeemNoTiers")}</p>}
      {tiers.map((tier) => (
        <article className="redemption-tier" key={tier.id}>
          <div>
            <strong>
              {tier.display_name} · {tier.face_value} {tier.face_currency}
            </strong>
            <small>{formatPoints(tier.points_cost, locale)} Points</small>
            <small>
              {t("availablePoints")}: {formatPoints(tier.balance, locale)}
            </small>
            {tier.pointsGap != null && (
              <small>
                {t("p0PointsGap", {
                  points: formatPoints(tier.pointsGap, locale),
                })}
              </small>
            )}
            {tier.usedToday != null && (
              <small>
                {t("p0Quota", {
                  count: String(tier.usedToday),
                  limit: String(tier.dailyCountLimit ?? "—"),
                  points: tier.pointsUsedToday ?? "—",
                  cap: tier.dailyPointsLimit ?? "—",
                })}
              </small>
            )}
          </div>
          <button
            disabled={busy || tier.canRedeem !== true}
            onClick={() => void redeem(tier)}
          >
            {tier.canRedeem === true
              ? t("redeemNow")
              : tier.unavailableReason === "insufficient_points" &&
                  tier.pointsGap != null
                ? t("p0PointsGap", {
                    points: formatPoints(tier.pointsGap, locale),
                  })
                : t(
                    reasonKeys[tier.unavailableReason ?? ""] ?? "p0Unavailable",
                  )}
          </button>
        </article>
      ))}
      {pendingOrder && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void recover(pendingOrder)}
        >
          {t("viewCode")}
        </button>
      )}
      {reveal && (
        <div className="redemption-code" role="status">
          <small>
            {t(
              reveal.status === "code_assigned"
                ? "code_assigned"
                : reveal.status === "review_required"
                  ? "review_required"
                  : "code_claimed",
            )}
          </small>
          {reveal.status === "code_assigned" ? (
            <button disabled={busy} onClick={() => void claim()}>
              {t("viewCode")}
            </button>
          ) : (
            <>
              <strong>{reveal.code}</strong>
              <button onClick={() => void copy()}>{t("copyCode")}</button>
            </>
          )}
          {safePlatformUrl(reveal.redemptionUrl) && (
            <a
              href={safePlatformUrl(reveal.redemptionUrl)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("openPlatform")}
            </a>
          )}
          <p className="muted">{t("platformUseNotice")}</p>
          {onOrders && (
            <button className="text-button" onClick={onOrders}>
              {t("myRedeem")}
            </button>
          )}
        </div>
      )}
      {notice && <p role={failed ? "alert" : "status"}>{notice}</p>}
    </section>
  );
}
