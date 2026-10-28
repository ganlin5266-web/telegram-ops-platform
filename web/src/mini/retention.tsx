import React, { useState } from "react";
import type { Home, MemberSummary, Page, PrimaryAction } from "./client";
import { formatDate, formatPoints, type Key, type Locale } from "./i18n";

type T = (k: Key, v?: Record<string, string>) => string;
const isInt = (v?: string | null): v is string => !!v && /^-?\d+$/.test(v);
export function growthGap(m?: MemberSummary): bigint | null {
  if (!isInt(m?.growth) || !isInt(m?.nextThreshold)) return null;
  const gap = BigInt(m!.nextThreshold!) - BigInt(m!.growth!);
  return gap > 0n ? gap : null;
}
export function nearLevelUp(m?: MemberSummary): boolean {
  const gap = growthGap(m);
  return (
    gap != null &&
    isInt(m?.nextThreshold) &&
    gap * 5n <= BigInt(m.nextThreshold)
  );
}
export type CheckinState = "available" | "done" | "pending" | "capped";
export function checkinState(m?: MemberSummary): CheckinState {
  if (m?.todayCheckedIn === true) return "done";
  if (m?.checkinStatus === "cap_reached") return "capped";
  // Missing status is unknown. Never infer eligibility from an absent field.
  if (m?.enabled && m.canCheckin === true && m.checkinStatus === "available")
    return "available";
  return "pending";
}
export function CheckinPanel({
  t,
  member,
  checkin,
  refresh,
  onInvite,
  primary = false,
  locale = "en",
}: {
  t: T;
  member?: MemberSummary;
  checkin: () => Promise<unknown>;
  refresh: () => Promise<Home>;
  onInvite: () => void;
  primary?: boolean;
  locale?: Locale;
  onBenefits?: () => void;
  doneView?: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [completed, setCompleted] = useState(false);
  const state = checkinState(member);
  let nextTime: string | null = null;
  if (member?.nextAvailableAt && member.businessTimezone) {
    try {
      nextTime =
        new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: member.businessTimezone,
        }).format(new Date(member.nextAvailableAt)) +
        ` (${member.businessTimezone})`;
    } catch {
      nextTime = null;
    }
  }
  return (
    <section
      className={`card checkin-panel ${primary ? "primary-action" : ""}`}
      data-testid="checkin-panel"
    >
      <div>
        <strong>{t("p0CheckinGrowth")}</strong>
        <small>{t("growthDifference")}</small>
      </div>
      {state === "done" ? (
        <div role="status" data-testid="daily-done">
          <strong>{t("p2DoneTitle")}</strong>
          {isInt(member?.actualGrowthEarned) && (
            <p>{t("p0CheckinEarned", { growth: member.actualGrowthEarned })}</p>
          )}
        </div>
      ) : state === "capped" ? (
        <p>{t("p0CheckinCap")}</p>
      ) : state === "pending" ? (
        <p>{t("p0CheckinUnknown")}</p>
      ) : (
        <button
          className={primary ? undefined : "secondary"}
          disabled={busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            setError(false);
            try {
              await checkin();
              await refresh();
              setCompleted(true);
            } catch {
              setError(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t(busy ? "loading" : "p2CheckinNow")}
        </button>
      )}
      {member?.checkinStatus === "cap_reached" && state === "done" && (
        <p>{t("p0CheckinCap")}</p>
      )}
      {nextTime && <small>{t("p0NextCheckin", { time: nextTime })}</small>}
      {error && <p role="alert">{t("p2CheckinFailed")}</p>}
      {completed && (
        <button className="text-button" onClick={onInvite}>
          {t("actionInvite")}
        </button>
      )}
    </section>
  );
}
const primaryMap: Record<
  PrimaryAction["kind"],
  {
    title: Key;
    cta: Key;
    to: "invite" | "rewards" | "bind" | "records" | "checkin";
  }
> = {
  view_code: { title: "viewCode", cta: "viewCode", to: "rewards" },
  redeem: { title: "redeemCentre", cta: "redeemNow", to: "rewards" },
  bind_uid: { title: "actionBind", cta: "bindCta", to: "bind" },
  view_identity: { title: "uidPending", cta: "p0ReviewUid", to: "bind" },
  checkin: { title: "p0CheckinGrowth", cta: "p2CheckinNow", to: "checkin" },
  invite: { title: "actionInvite", cta: "inviteCta", to: "invite" },
  view_records: { title: "p0ViewRecords", cta: "p0ViewRecords", to: "records" },
};
export function isKnownPrimary(a?: PrimaryAction | null): a is PrimaryAction {
  return !!a && typeof a === "object" && a.kind in primaryMap;
}
export function BackendPrimary({
  t,
  action,
  go,
}: {
  t: T;
  action: PrimaryAction;
  go: (to: string, orderId?: string) => void;
}) {
  const m = primaryMap[action.kind];
  return (
    <section className="primary-action" data-testid="primary-action">
      <strong>{t(m.title)}</strong>
      <button onClick={() => go(m.to, action.orderId)}>{t(m.cta)}</button>
    </section>
  );
}
const referralStatus: Record<string, Key> = {
  pending: "pending",
  rewarded: "p2RsRewarded",
  cap_exceeded: "p0CapExceeded",
  review_required: "p0ReviewRequired",
};
export function InviteJourney({
  t,
  locale,
  home,
  page,
  busy,
  more,
  onCheckin,
}: {
  t: T;
  locale: Locale;
  home: Home;
  page?: Page;
  busy: boolean;
  more: () => void;
  onCheckin?: () => void;
}) {
  const r = home.referral;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  // Only Telegram deep links from the authenticated backend are shareable.
  const canShare =
    !!r?.shareUrl &&
    /^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=ref_[A-Za-z0-9_-]+$/.test(
      r.shareUrl,
    );
  const share = () => {
    if (!canShare) return;
    const link =
      "https://t.me/share/url?url=" + encodeURIComponent(r!.shareUrl!);
    const tg = window.Telegram?.WebApp as
      { openTelegramLink?: (url: string) => void } | undefined;
    if (tg?.openTelegramLink) tg.openTelegramLink(link);
    else window.open(link, "_blank", "noopener,noreferrer");
  };
  const copy = async () => {
    if (!canShare) return;
    try {
      await navigator.clipboard.writeText(r!.shareUrl!);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  return (
    <>
      <section className="hero invite-hero" data-testid="invite-hero">
        <span className="pill">{t("friends")}</span>
        {r?.activity && r.rewardEligible ? (
          <div className="invite-offer">
            <strong>
              {t("p0InviterReward", { points: r.activity.inviterPoints })}
            </strong>
            {r.activity.inviteeEnabled && (
              <p>
                {t("p0InviteeReward", { points: r.activity.inviteePoints })}
              </p>
            )}
            <small>{t("p2ShareNote")}</small>
          </div>
        ) : (
          <div className="pending-note">
            <p>
              {t(
                r?.rewardAvailability === "member_required"
                  ? "p0MemberPending"
                  : r?.activity
                    ? "p0RewardInactive"
                    : "p0NoActivity",
              )}
            </p>
            {r?.rewardAvailability === "member_required" &&
              home.member?.canCheckin === true &&
              onCheckin && (
                <button className="text-button" onClick={onCheckin}>
                  {t("p0CheckinGrowth")}
                </button>
              )}
          </div>
        )}
        {r ? (
          <div className="invite-progress">
            {isInt(r.rewardedToday) && (
              <div>
                <small>{t("p0RewardedToday")}</small>
                <strong>
                  {formatPoints(r.rewardedToday, locale)} /{" "}
                  {r.dailyCap ?? r.dailyRewardLimit ?? "—"}
                </strong>
              </div>
            )}
            {isInt(r.pendingCount) && (
              <div>
                <small>{t("p0PendingInvites")}</small>
                <strong>{formatPoints(r.pendingCount, locale)}</strong>
              </div>
            )}
            {isInt(r.pointsEarned) && (
              <div>
                <small>{t("p2PointsEarned")}</small>
                <strong>{formatPoints(r.pointsEarned, locale)}</strong>
              </div>
            )}
          </div>
        ) : (
          <p data-testid="referral-pending">{t("p2ReferralPending")}</p>
        )}
        {r?.businessDate && (
          <small>
            {r.businessDate} · {r.businessTimezone}
          </small>
        )}
        {canShare ? (
          <div className="invite-actions">
            <button onClick={share}>{t("inviteShare")}</button>
            <button className="secondary" onClick={() => void copy()}>
              {t(copyState === "copied" ? "inviteCopied" : "inviteCopy")}
            </button>
            {copyState === "failed" && (
              <small role="alert">{t("inviteCopyFailed")}</small>
            )}
          </div>
        ) : (
          <button disabled>{t("p2ShareSoon")}</button>
        )}
      </section>
      <section className="card history">
        <h2>{t("inviteHistory")}</h2>
        {!page && busy && <p>{t("loading")}</p>}
        {page?.items.length === 0 && (
          <div className="empty-small">
            <h3>{t("inviteEmpty")}</h3>
            <p>{t("inviteHint")}</p>
          </div>
        )}
        {page?.items.map((row, i) => (
          <article className="record" key={row.id}>
            <div>
              <strong>
                {t("p2Friend")} {i + 1}
              </strong>
              <small>{formatDate(row.created_at, locale)}</small>
            </div>
            <span>
              {t(referralStatus[row.displayStatus ?? ""] ?? "p0ReviewRequired")}
            </span>
          </article>
        ))}
        {page?.nextCursor && (
          <button className="text-button" disabled={busy} onClick={more}>
            {t("more")}
          </button>
        )}
      </section>
      <details className="card">
        <summary>{t("p0InvitationRules")}</summary>
        <ol className="journey">
          <li>{t("journey1")}</li>
          <li>{t("p2StepBind")}</li>
          <li>{t("p2StepQualify")}</li>
          <li>{t("p2StepReward")}</li>
        </ol>
        <p>{t("p2ShareNote")}</p>
        <p>{t("p0UidNoGuaranteedReward")}</p>
      </details>
    </>
  );
}
