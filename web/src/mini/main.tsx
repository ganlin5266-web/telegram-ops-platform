import { MemberCard } from "./MemberCard";
import { Icon } from "./icons";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient, MiniError, type Home, type Page } from "./client";
import { miniBrand } from "./brand";
import {
  supportedUiLocales,
  localeNames,
  resolveLocale,
  translate,
  formatPoints,
  formatDate,
  readPreference,
  savePreference,
  contentLocale,
  type Locale,
  type Key,
} from "./i18n";
import PlatformAccounts from "./PlatformAccounts";
import RedemptionCentre from "./RedemptionCentre";
import {
  CheckinPanel,
  BackendPrimary,
  InviteJourney,
  isKnownPrimary,
} from "./retention";
import "./style.css";
const tabs = ["home", "rewards", "invite", "me"] as const;
type Tab = (typeof tabs)[number] | "membership";
type Kind = "point-ledger" | "referrals" | "redemptions";
export function MiniApp({
  client: injected,
}: { client?: ReturnType<typeof createClient> } = {}) {
  const client = useRef(injected ?? createClient()).current;
  const [tab, setTab] = useState<Tab>("home"),
    [home, setHome] = useState<Home>(),
    [platformId, setPlatformId] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<MiniError>(),
    [out, setOut] = useState(false),
    [kind, setKind] = useState<Kind>("point-ledger"),
    [page, setPage] = useState<Page>(),
    [recoverRedemptionId, setRecoverRedemptionId] = useState<string>(),
    [panel, setPanel] = useState<
      "language" | "help" | "platformAccount" | null
    >(null),
    [device, setDevice] = useState<Locale | undefined>(() =>
      readPreference(miniBrand.preferenceKey),
    );
  // A navigation hint never selects identity/scope; Telegram authentication still does.
  const inviteEntry = useRef(
    new URLSearchParams(window.location.search).get("view") === "invite",
  );
  const version = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (panel) {
      panelRef.current?.focus({ preventScroll: true });
      panelRef.current?.scrollIntoView?.({ block: "start" });
    }
  }, [panel]);
  const locale = resolveLocale({
    device,
    preferred: home?.profile.preferredLanguage,
    bot: home?.profile.botLanguage,
    project: home?.profile.projectLanguage ?? miniBrand.defaultLocale,
    telegram: home?.profile.telegramLanguage,
    fallback: miniBrand.defaultLocale,
  });
  const t = (k: Key, v?: Record<string, string>) => translate(locale, k, v);
  useEffect(() => {
    document.documentElement.lang = contentLocale(locale);
    document.title = miniBrand.name;
  }, [locale]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof MiniError ? e : new MiniError("invalid_json"));
    } finally {
      setBusy(false);
    }
  }
  const load = () =>
    run(async () => {
      if (!client.connected)
        await client.connect(window.Telegram?.WebApp?.initData ?? "");
      setHome(await client.home(platformId));
      if (inviteEntry.current) {
        const invitations = await client.page(
          "referrals",
          undefined,
          platformId,
        );
        setTab("invite");
        setKind("referrals");
        setPage(invitations);
        inviteEntry.current = false;
      }
    });
  useEffect(() => {
    window.Telegram?.WebApp?.ready?.();
    void load();
    const forget = () => client.forget();
    window.addEventListener("pagehide", forget);
    return () => window.removeEventListener("pagehide", forget);
  }, []);
  const records = (k: Kind, more = false) => {
    const v = ++version.current;
    return run(async () => {
      const next = await client.page(
        k,
        more ? (page?.nextCursor ?? undefined) : undefined,
        platformId,
      );
      if (v === version.current)
        setPage(
          more
            ? { ...next, items: [...(page?.items ?? []), ...next.items] }
            : next,
        );
    });
  };
  function select(next: Tab, k?: Kind) {
    version.current++;
    setTab(next);
    setPage(undefined);
    setError(undefined);
    setPanel(null);
    if (next === "rewards" || next === "invite") {
      const history = k ?? (next === "invite" ? "referrals" : "redemptions");
      setKind(history);
      void records(history);
    }
  }
  function historySelect(k: Kind) {
    setKind(k);
    setPage(undefined);
    void records(k);
  }
  const titleKey =
    kind === "point-ledger"
      ? "ledger"
      : kind === "referrals"
        ? "inviteHistory"
        : "myRedeem";
  const emptyKey =
    kind === "point-ledger"
      ? "ledgerEmpty"
      : kind === "referrals"
        ? "inviteEmpty"
        : "redeemEmpty";
  const hintKey =
    kind === "point-ledger"
      ? "ledgerHint"
      : kind === "referrals"
        ? "inviteHint"
        : "redeemHint";
  const history = (
    <section className="card history">
      <h2>{t(titleKey)}</h2>
      {!page && busy && <div className="skeleton" aria-hidden="true" />}
      {page?.items.length === 0 && (
        <div className="empty-small">
          <span aria-hidden="true">≋</span>
          <h3>{t(emptyKey)}</h3>
          <p className="muted">{t(hintKey)}</p>
        </div>
      )}
      {page?.items.map((r) => (
        <article className="record" key={r.id}>
          <div>
            <strong>
              {t(
                kind === "point-ledger"
                  ? r.delta?.startsWith("-")
                    ? "spend"
                    : "income"
                  : kind === "referrals"
                    ? "relation"
                    : "requestRecord",
              )}
            </strong>
            <small>{formatDate(r.created_at, locale)}</small>
          </div>
          <div>
            {r.delta ? (
              <strong className={r.delta.startsWith("-") ? "" : "positive"}>
                {r.delta.startsWith("-") ? "" : "+"}
                {formatPoints(r.delta, locale)}
              </strong>
            ) : r.points_cost ? (
              <strong>
                {formatPoints(r.points_cost, locale)} {t("pointsUnit")}
              </strong>
            ) : null}
            <small>
              {t(
                (r.status &&
                [
                  "bound",
                  "qualified",
                  "invalid",
                  "pending",
                  "processing",
                  "success",
                  "failed",
                  "cancelled",
                  "code_assigned",
                  "code_claimed",
                  "review_required",
                  "refunded",
                ].includes(r.status)
                  ? r.status
                  : r.status
                    ? "recorded"
                    : "posted") as Key,
              )}
            </small>
            {kind === "redemptions" &&
              ["code_assigned", "code_claimed", "review_required"].includes(
                r.status ?? "",
              ) && (
                <button
                  className="text-button"
                  onClick={() => setRecoverRedemptionId(r.id)}
                >
                  {t("viewCode")}
                </button>
              )}
          </div>
        </article>
      ))}
      {page?.nextCursor && (
        <button
          className="text-button"
          disabled={busy}
          onClick={() => void records(kind, true)}
        >
          {t("more")}
        </button>
      )}
    </section>
  );
  const balance = formatPoints(home?.points.balance, locale);
  const refreshHome = async () => {
    const h = await client.home(platformId);
    setHome(h);
    return h;
  };
  const go = (to: string, orderId?: string) => {
    if (to === "bind") openBind();
    else if (to === "checkin")
      document
        .getElementById("daily-checkin")
        ?.scrollIntoView({ behavior: "smooth" });
    else if (to === "records") select("rewards", "redemptions");
    else {
      if (orderId) setRecoverRedemptionId(orderId);
      select(to as Tab);
    }
  };
  const choosePlatform = (id: string) => {
    version.current++;
    setPage(undefined);
    setRecoverRedemptionId(undefined);
    void run(async () => {
      const next = await client.home(id);
      setHome(next);
      setPlatformId(id);
      if (tab === "invite") {
        setPage(await client.page("referrals", undefined, id));
      }
    });
  };
  const openBind = () => {
    select("me");
    setPanel("platformAccount");
  };
  return (
    <div className={`mini-shell theme-${miniBrand.theme}`}>
      <header>
        <div className="brand">
          {miniBrand.logo ? (
            <img src={miniBrand.logo} alt={miniBrand.name} />
          ) : (
            <span className="brand-mark" aria-hidden="true">
              {miniBrand.monogram}
            </span>
          )}
          <strong>{miniBrand.name}</strong>
          {miniBrand.staging && <small className="stage">{t("staging")}</small>}
        </div>
        <span className="avatar" aria-hidden="true">
          {home?.profile.displayName.slice(0, 1) || miniBrand.monogram}
        </span>
      </header>
      {!home || out ? (
        <main>
          {!home && !out && busy && (
            <div className="home-skeleton" aria-hidden="true" />
          )}
          <section className="hero">
            <p className="eyebrow">{t("space")}</p>
            <h1>
              {out ? t("loggedOut") : t("greeting", { brand: miniBrand.name })}
            </h1>
            <p>{t("intro")}</p>
            {!out ? (
              <button disabled={busy} onClick={() => void load()}>
                {t(busy ? "connecting" : "connect")}
              </button>
            ) : (
              <p>{t("reopen")}</p>
            )}
          </section>
        </main>
      ) : (
        <main>
          {(tab === "rewards" || tab === "invite") && (
            <button className="text-button" onClick={() => select("me")}>
              ← {t("back")}
            </button>
          )}
          <div className="title">
            <h1>
              {tab === "home"
                ? t("welcome", {
                    name: home.profile.displayName || t("member"),
                  })
                : t(tab)}
            </h1>
          </div>
          {["home", "invite", "rewards"].includes(tab) &&
            !!home.platforms?.length && (
              <label className="platform-picker">
                {t("p0Platform")}
                <select
                  disabled={busy}
                  value={home.currentPlatform?.id ?? ""}
                  onChange={(e) => choosePlatform(e.target.value)}
                >
                  {home.platforms.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </label>
            )}
          {tab === "home" && (
            <>
              <section
                className="hero points-card"
                aria-label={t("points")}
                data-testid="today-focus"
              >
                <span className="pill">{t("points")}</span>
                <div className="balance">
                  {balance}
                  <small> Points</small>
                </div>
                <p>{t("pointsBody")}</p>
                {home.points.expiringSoon &&
                  home.points.expiringSoon !== "0" && (
                    <small>
                      {t("pointsExpiring", {
                        amount: formatPoints(home.points.expiringSoon, locale),
                      })}
                    </small>
                  )}
                <div className="next-reward">
                  <small>{t("p0NextReward")}</small>
                  {home.recommendedRedemption ? (
                    <>
                      <strong>
                        {home.recommendedRedemption.face_value}{" "}
                        {home.recommendedRedemption.face_currency}
                      </strong>
                      <span>
                        {formatPoints(
                          home.recommendedRedemption.points_cost,
                          locale,
                        )}{" "}
                        Points
                      </span>
                      {home.recommendedRedemption.pointsGap != null && (
                        <p>
                          {t("p0PointsGap", {
                            points: formatPoints(
                              home.recommendedRedemption.pointsGap,
                              locale,
                            ),
                          })}
                        </p>
                      )}
                    </>
                  ) : (
                    <p>{t("p0NoReward")}</p>
                  )}
                </div>
              </section>
              {isKnownPrimary(home.primaryAction) &&
                home.primaryAction.kind !== "checkin" && (
                  <BackendPrimary t={t} action={home.primaryAction} go={go} />
                )}
              <div id="daily-checkin">
                <CheckinPanel
                  t={t}
                  locale={locale}
                  member={home.member}
                  checkin={client.memberCheckin}
                  refresh={refreshHome}
                  onInvite={() => select("invite")}
                  primary={home.primaryAction?.kind === "checkin"}
                />
              </div>
              <section className="card home-invitation">
                <h2>{t("actionInvite")}</h2>
                {home.referral?.rewardedToday != null && (
                  <p>
                    {t("p0RewardedToday")}: {home.referral.rewardedToday} /{" "}
                    {home.referral.dailyCap ??
                      home.referral.dailyRewardLimit ??
                      "—"}
                  </p>
                )}
                {home.referral?.pendingCount != null && (
                  <small>
                    {t("p0PendingInvites")}: {home.referral.pendingCount}
                  </small>
                )}
                <button
                  className="text-button"
                  onClick={() => select("invite")}
                >
                  {t("inviteHistory")} →
                </button>
              </section>
              <section className="card">
                <h2>{t("myRedeem")}</h2>
                {home.recentOrders?.length ? (
                  home.recentOrders.map((order) => (
                    <article key={order.id} className="record">
                      <small>{formatDate(order.created_at, locale)}</small>
                      <span>
                        {formatPoints(order.points_cost, locale)} Points
                      </span>
                      <button
                        className="text-button"
                        onClick={() =>
                          go(
                            "rewards",
                            [
                              "code_assigned",
                              "code_claimed",
                              "review_required",
                            ].includes(order.status ?? "")
                              ? order.id
                              : undefined,
                          )
                        }
                      >
                        {t("p0ViewRecords")}
                      </button>
                    </article>
                  ))
                ) : (
                  <p>{t("redeemEmpty")}</p>
                )}
              </section>
              <button
                className="text-button"
                onClick={() => select("membership")}
              >
                {t("membership")} · Growth →
              </button>
              <p className="aside-note">{t("growthDifference")}</p>
            </>
          )}
          {tab === "membership" && (
            <>
              <MemberCard
                member={home.member}
                locale={locale}
                history={client.memberHistory}
              />
              <p className="aside-note">{t("growthDifference")}</p>
            </>
          )}
          {tab === "rewards" && (
            <>
              <section className="hero points-card">
                <span className="pill">{t("availablePoints")}</span>
                <div className="balance">
                  {balance}
                  <small> {t("pointsUnit")}</small>
                </div>
                <p>
                  {t(
                    home.points.accountExists
                      ? "pointsBody"
                      : "pointsEmptyBody",
                  )}
                </p>
              </section>
              {home.points.expiringSoon && home.points.expiringSoon !== "0" && (
                <p>
                  {t("pointsExpiring", {
                    amount: formatPoints(home.points.expiringSoon, locale),
                  })}
                </p>
              )}
              <div className="reward-actions">
                <button
                  aria-pressed={kind === "point-ledger"}
                  onClick={() => historySelect("point-ledger")}
                >
                  {t("ledger")}
                </button>
                <button
                  aria-pressed={kind === "redemptions"}
                  onClick={() => historySelect("redemptions")}
                >
                  {t("myRedeem")}
                </button>
              </div>
              {kind === "redemptions" && (
                <RedemptionCentre
                  client={client}
                  locale={locale}
                  t={t}
                  onChanged={refreshHome}
                  recoverId={recoverRedemptionId}
                  platformId={home.currentPlatform?.id}
                  onOrders={() => historySelect("redemptions")}
                />
              )}
              {history}
            </>
          )}
          {tab === "invite" && (
            <InviteJourney
              t={t}
              locale={locale}
              home={home}
              page={kind === "referrals" ? page : undefined}
              busy={busy}
              more={() => void records("referrals", true)}
              onCheckin={() => select("home")}
            />
          )}
          {tab === "me" && (
            <>
              <section className="card profile-card">
                <span className="avatar large" aria-hidden="true">
                  {home.profile.displayName.slice(0, 1) || miniBrand.monogram}
                </span>
                <div>
                  <h2>{home.profile.displayName || t("member")}</h2>
                  <p className="muted">{t("space")}</p>
                </div>
              </section>
              <section className="card links">
                <button onClick={() => select("rewards")}>
                  {t("points")}
                  <span aria-hidden="true">→</span>
                </button>
                <button onClick={() => select("invite")}>
                  {t("inviteHistory")}
                  <span aria-hidden="true">→</span>
                </button>
                <button onClick={() => select("rewards", "redemptions")}>
                  {t("myRedeem")}
                  <span aria-hidden="true">→</span>
                </button>
                <button onClick={() => select("membership")}>
                  {t("membership")} · Growth<span aria-hidden="true">→</span>
                </button>
                <button onClick={() => setPanel("platformAccount")}>
                  {t("platformAccount")}
                  <span aria-hidden="true">→</span>
                </button>
                <button onClick={() => setPanel("language")}>
                  {t("language")}
                  <span>{localeNames[locale]} →</span>
                </button>
                <button onClick={() => setPanel("help")}>
                  {t("help")}
                  <span aria-hidden="true">→</span>
                </button>
              </section>
              <button
                className="logout"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await client.logout();
                    version.current++;
                    setHome(undefined);
                    setPage(undefined);
                    setPanel(null);
                    setOut(true);
                  })
                }
              >
                {t("logout")}
              </button>
            </>
          )}
          {panel && (
            <section
              className="card panel"
              ref={panelRef}
              tabIndex={-1}
              role="region"
              aria-label={t(panel)}
            >
              <div className="card-top">
                <h2>{t(panel)}</h2>
                <button className="text-button" onClick={() => setPanel(null)}>
                  {t("close")}
                </button>
              </div>
              {panel === "platformAccount" ? (
                <PlatformAccounts
                  client={client}
                  locale={locale}
                  onChanged={refreshHome}
                />
              ) : panel === "language" ? (
                <>
                  <div className="language-options">
                    {supportedUiLocales.map((l) => (
                      <button
                        key={l}
                        aria-pressed={locale === l}
                        onClick={() => {
                          savePreference(miniBrand.preferenceKey, l);
                          setDevice(l);
                        }}
                      >
                        {localeNames[l]}
                        {locale === l && <span aria-hidden="true">✓</span>}
                      </button>
                    ))}
                  </div>
                  <p className="muted">{t("localeDevice")}</p>
                  {contentLocale(locale) !== locale && (
                    <p role="status">{t("fallbackNotice")}</p>
                  )}
                </>
              ) : (
                <>
                  <p>{t("helpBody")}</p>
                  {miniBrand.helpUrl && (
                    <a
                      href={miniBrand.helpUrl}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {t("help")}
                    </a>
                  )}
                </>
              )}
            </section>
          )}
        </main>
      )}
      {busy && (
        <p role="status" className="notice">
          {t("loading")}
        </p>
      )}
      {error && (
        <aside role="alert" className="notice error">
          <p>{t(error.kind)}</p>
          {error.requestId && (
            <details>
              <summary>{t("diagnostics")}</summary>
              <small>
                {t("supportId")}: {error.requestId}
              </small>
            </details>
          )}
          {!out && error.kind !== "unauthorized" && (
            <button
              disabled={busy}
              onClick={() =>
                home && (tab === "rewards" || tab === "invite")
                  ? void records(kind)
                  : void load()
              }
            >
              {t("retry")}
            </button>
          )}
        </aside>
      )}
      {home && !out && (
        <nav aria-label={t("navigation")}>
          {tabs.map((item, i) => (
            <button
              key={item}
              aria-current={
                item === tab || (item === "me" && tab === "membership")
                  ? "page"
                  : undefined
              }
              disabled={busy}
              onClick={() => select(item)}
            >
              <Icon name={["home", "gift", "users", "user"][i]} />
              {t(item)}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
const root = document.getElementById("mini-root");
if (root) createRoot(root).render(<MiniApp />);
