// Phase 2 · Retention + Referral presentation. Everything here renders only
// values the backend returned; missing contract fields fall back to safe,
// clearly "not open yet" states and are never inferred or persisted locally.
import React, { useState } from "react";
import type { Home, MemberSummary, Page, PrimaryAction } from "./client";
import { Icon } from "./icons";
import { formatDate, formatPoints, type Key, type Locale } from "./i18n";

type T = (k: Key, v?: Record<string, string>) => string;
const isInt = (v?: string | null): v is string => !!v && /^-?\d+$/.test(v);

export function growthGap(m?: MemberSummary): bigint | null {
  if (!isInt(m?.growth) || !isInt(m?.nextThreshold)) return null;
  const gap = BigInt(m!.nextThreshold!) - BigInt(m!.growth!);
  return gap > 0n ? gap : null;
}
// Frontend Presentation Threshold only: gap <= 20% of next threshold. It may
// only drive visual emphasis and the "earn Growth" hint; it never affects
// Level, Growth, Reward, Eligibility, Qualification or any backend result.
export function nearLevelUp(m?: MemberSummary): boolean {
  const gap = growthGap(m);
  if (gap == null || !isInt(m?.nextThreshold)) return false;
  return gap * 5n <= BigInt(m!.nextThreshold!);
}
export type CheckinState = "available" | "done" | "pending";
export function checkinState(m?: MemberSummary): CheckinState {
  if (m?.todayCheckedIn === true) return "done";
  if (m?.todayCheckinAvailable === false) return "pending";
  // Contract fields missing: keep the safe fallback (button; backend is idempotent).
  return "available";
}

type Feedback = {
  delta: string | null;
  from?: string;
  to?: string;
  gap: string | null;
  nextLevel: number;
  levelUp: number | null;
};

export function CheckinPanel({
  t,
  member,
  checkin,
  refresh,
  onInvite,
  onBenefits,
  doneView = null,
}: {
  doneView?: React.ReactNode;
  t: T;
  member?: MemberSummary;
  checkin: () => Promise<unknown>;
  refresh: () => Promise<Home>;
  onInvite: () => void;
  onBenefits: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [fb, setFb] = useState<Feedback>();
  const state = checkinState(member);
  if (fb)
    return (
      <div className="primary-action feedback" role="status">
        {fb.levelUp != null ? (
          <>
            <span className="levelup-mark" aria-hidden="true">
              <Icon name="badge" />
            </span>
            <strong>{t("p2LevelUp", { level: String(fb.levelUp) })}</strong>
            <small>{t("p2LevelUpBody")}</small>
          </>
        ) : (
          <strong>{t("p2CheckinDone")}</strong>
        )}
        {fb.delta && <b className="gain">+{fb.delta} Growth</b>}
        {fb.from && fb.to && (
          <small>{t("p2GrowthChange", { from: fb.from, to: fb.to })}</small>
        )}
        {fb.gap && (
          <small>
            {t("p2GapTo", { gap: fb.gap, level: String(fb.nextLevel) })}
          </small>
        )}
        {fb.levelUp != null ? (
          <button onClick={onBenefits}>{t("p2ViewBenefits")}</button>
        ) : (
          <button onClick={onInvite}>{t("p2InviteNext")}</button>
        )}
      </div>
    );
  if (state === "done") return <>{doneView}</>;
  return (
    <div className="primary-action">
      <div>
        <strong>{t("checkinTitle")}</strong>
        <small>{t("checkinBody")}</small>
      </div>
      {error && <p role="alert">{t("p2CheckinFailed")}</p>}
      {state === "pending" ? (
        <p className="pending-note">{t("p2CheckinPending")}</p>
      ) : (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(false);
            const before = member;
            try {
              await checkin();
              const after = (await refresh()).member;
              const d =
                isInt(before?.growth) && isInt(after?.growth)
                  ? BigInt(after!.growth!) - BigInt(before!.growth!)
                  : null;
              const gap = growthGap(after);
              setFb({
                delta: d != null && d > 0n ? d.toString() : null,
                from: before?.growth,
                to: after?.growth,
                gap: gap?.toString() ?? null,
                nextLevel: (after?.level ?? 0) + 1,
                levelUp:
                  after?.level != null &&
                  before?.level != null &&
                  after.level > before.level
                    ? after.level
                    : null,
              });
            } catch {
              setError(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("p2CheckinNow")}
        </button>
      )}
    </div>
  );
}

export function DailyDone({
  t,
  go,
}: {
  t: T;
  go: (to: "activities" | "invite" | "rewards") => void;
}) {
  return (
    <div className="primary-action done" data-testid="daily-done">
      <div>
        <strong>{t("p2DoneTitle")}</strong>
        <small>{t("p2DoneBody")}</small>
      </div>
      <div className="light-links">
        <button onClick={() => go("activities")}>
          {t("p2ViewActivities")}
        </button>
        <button onClick={() => go("invite")}>{t("actionInvite")}</button>
        <button onClick={() => go("rewards")}>{t("p2ViewRewards")}</button>
      </div>
    </div>
  );
}

// Backend-selected primary action (BACKEND_PENDING). The frontend only maps
// the returned type to a destination; it never ranks economic priority itself.
const primaryMap: Record<
  PrimaryAction,
  { title: Key; cta: Key; to: "membership" | "invite" | "rewards" | "bind" }
> = {
  checkin: { title: "checkinTitle", cta: "p2CheckinNow", to: "membership" },
  invite: { title: "actionInvite", cta: "inviteCta", to: "invite" },
  earn_growth: { title: "growthWays", cta: "p2EarnGrowth", to: "membership" },
  redeem_points: { title: "rewardCentre", cta: "p2ViewRewards", to: "rewards" },
  bind_platform: { title: "actionBind", cta: "bindCta", to: "bind" },
  member_benefits: {
    title: "currentBenefits",
    cta: "p2ViewBenefits",
    to: "membership",
  },
};
export function isKnownPrimary(a?: string | null): a is PrimaryAction {
  return !!a && a in primaryMap;
}
export function BackendPrimary({
  t,
  action,
  go,
}: {
  t: T;
  action: PrimaryAction;
  go: (to: "membership" | "invite" | "rewards" | "bind") => void;
}) {
  const m = primaryMap[action];
  return (
    <div className="primary-action">
      <div>
        <strong>{t(m.title)}</strong>
      </div>
      <button onClick={() => go(m.to)}>{t(m.cta)}</button>
    </div>
  );
}

type Way = {
  key: string;
  icon: string;
  title: Key;
  what: Key;
  gain: Key;
  group: "best" | "available" | "done" | "pending";
  status: Key;
  cta?: () => void;
};
export function GrowthWays({
  t,
  member,
  memberOn,
  platformVerified,
  onCheckin,
  onInvite,
  onBind,
}: {
  t: T;
  member?: MemberSummary;
  memberOn: boolean;
  platformVerified?: boolean;
  onCheckin: () => void;
  onInvite: () => void;
  onBind: () => void;
}) {
  const ci = memberOn ? checkinState(member) : "pending";
  const ways: Way[] = [
    {
      key: "checkin",
      icon: "check",
      title: "p2WayCheckin",
      what: "p2WayCheckinDo",
      gain: "p2GainGrowth",
      group: ci === "done" ? "done" : ci === "available" ? "best" : "pending",
      status:
        ci === "done"
          ? "p2Completed"
          : ci === "available"
            ? "p2Available"
            : "p2NotOpen",
      cta: ci === "available" ? onCheckin : undefined,
    },
    {
      key: "invite",
      icon: "users",
      title: "actionInvite",
      what: "p2WayInviteDo",
      gain: "p2GainPending",
      group: ci === "available" ? "available" : "best",
      status: "p2Available",
      cta: onInvite,
    },
    {
      key: "platform",
      icon: "link",
      title: "wayPlatform",
      what: "p2WayPlatformDo",
      gain: "p2GainPending",
      group: platformVerified ? "done" : "available",
      status: platformVerified ? "p2Completed" : "p2Available",
      cta: platformVerified ? undefined : onBind,
    },
  ];
  const groups = [
    ["best", "p2Best"],
    ["available", "p2Available"],
    ["done", "p2Completed"],
    ["pending", "p2NotOpen"],
  ] as const;
  return (
    <div className="growth-ways" data-testid="growth-ways">
      {groups.map(([g, label]) => {
        const items = ways.filter((w) => w.group === g);
        if (!items.length) return null;
        return (
          <section key={g} className={`way-group ${g}`}>
            <h3>{t(label)}</h3>
            {items.map((w) => (
              <article className="way" key={w.key} data-way={w.key}>
                <span className="tile-icon">
                  <Icon name={w.icon} />
                </span>
                <span className="way-body">
                  <strong>{t(w.title)}</strong>
                  <small>{t(w.what)}</small>
                  <small className="way-gain">{t(w.gain)}</small>
                </span>
                {w.cta ? (
                  <button onClick={w.cta}>{t("p2Go")}</button>
                ) : (
                  <span className={`way-status ${g}`}>{t(w.status)}</span>
                )}
              </article>
            ))}
          </section>
        );
      })}
    </div>
  );
}

const referralStatus: Record<string, Key> = {
  invited: "p2RsInvited",
  registered: "p2RsRegistered",
  bound: "bound",
  qualified: "qualified",
  rewarded: "p2RsRewarded",
  invalid: "invalid",
  pending: "pending",
};
const rewardDone = new Set(["rewarded", "granted", "success", "posted"]);

export function InviteJourney({
  t,
  locale,
  home,
  page,
  busy,
  more,
}: {
  t: T;
  locale: Locale;
  home: Home;
  page?: Page;
  busy: boolean;
  more: () => void;
}) {
  const r = home.referral;
  const hasStats =
    isInt(r?.qualifiedToday) ||
    isInt(r?.growthEarned) ||
    isInt(r?.remainingRewardChances);
  const share = () => {
    const url = r?.shareUrl;
    if (!url || !/^https:\/\//.test(url)) return;
    const link = "https://t.me/share/url?url=" + encodeURIComponent(url);
    const tg = window.Telegram?.WebApp as
      { openTelegramLink?: (u: string) => void } | undefined;
    if (tg?.openTelegramLink) tg.openTelegramLink(link);
    else window.open(link, "_blank", "noopener");
  };
  const canShare = !!r?.shareUrl && /^https:\/\//.test(r.shareUrl);
  return (
    <>
      <section className="hero invite-hero" data-testid="invite-hero">
        <span className="pill">{t("friends")}</span>
        {hasStats ? (
          <div className="invite-progress">
            {isInt(r?.qualifiedToday) && (
              <div>
                <small>{t("p2TodayQualified")}</small>
                <strong>
                  {formatPoints(r!.qualifiedToday!, locale)}
                  {isInt(r?.dailyRewardLimit) && (
                    <span> / {formatPoints(r!.dailyRewardLimit!, locale)}</span>
                  )}
                </strong>
              </div>
            )}
            {isInt(r?.growthEarned) && (
              <div>
                <small>{t("p2GrowthEarned")}</small>
                <strong>{formatPoints(r!.growthEarned!, locale)}</strong>
              </div>
            )}
            {isInt(r?.remainingRewardChances) && (
              <div>
                <small>{t("p2Remaining")}</small>
                <strong>
                  {formatPoints(r!.remainingRewardChances!, locale)}
                </strong>
              </div>
            )}
          </div>
        ) : (
          <p className="pending-note" data-testid="referral-pending">
            {t("p2ReferralPending")}
          </p>
        )}
        {canShare ? (
          <button onClick={share}>{t("actionInvite")}</button>
        ) : (
          <button disabled>{t("p2ShareSoon")}</button>
        )}
      </section>
      <div className="summary invite-summary">
        <div>
          <strong>{formatPoints(home.invitedCount, locale)}</strong>
          <span>{t("invited")}</span>
        </div>
        {isInt(r?.qualifiedTotal) && (
          <div>
            <strong>{formatPoints(r!.qualifiedTotal!, locale)}</strong>
            <span>{t("p2QualifiedTotal")}</span>
          </div>
        )}
      </div>
      <section className="card history">
        <h2>{t("inviteHistory")}</h2>
        {!page && busy && <div className="skeleton" aria-hidden="true" />}
        {page?.items.length === 0 && (
          <div className="empty-small">
            <h3>{t("inviteEmpty")}</h3>
            <p className="muted">{t("inviteHint")}</p>
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
            <div>
              {row.status && referralStatus[row.status] && (
                <span className={`rs rs-${row.status}`}>
                  {t(referralStatus[row.status])}
                </span>
              )}
              {row.reward_status && rewardDone.has(row.reward_status) && (
                <small className="positive">{t("p2RsRewarded")}</small>
              )}
            </div>
          </article>
        ))}
        {page?.nextCursor && (
          <button className="text-button" disabled={busy} onClick={more}>
            {t("more")}
          </button>
        )}
      </section>
      <section className="card">
        <h2>{t("p2StepsTitle")}</h2>
        <ol className="journey steps5">
          {(
            [
              "journey1",
              "p2StepRegister",
              "p2StepBind",
              "p2StepQualify",
              "p2StepReward",
            ] as const
          ).map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ol>
        <p className="muted">{t("p2ShareNote")}</p>
      </section>
      <div className="placeholder-row card">
        <span>{t("rules")}</span>
        <small>{t("rulesUnpublished")}</small>
      </div>
    </>
  );
}
