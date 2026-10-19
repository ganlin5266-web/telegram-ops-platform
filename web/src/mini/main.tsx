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
  DailyDone,
  BackendPrimary,
  GrowthWays,
  InviteJourney,
  checkinState,
  isKnownPrimary,
  nearLevelUp,
} from "./retention";
import "./style.css";
const tabs = ["home", "membership", "activities", "games", "me"] as const;
type Tab = (typeof tabs)[number] | "rewards" | "invite";
type Kind = "point-ledger" | "referrals" | "redemptions";
export function MiniApp({
  client: injected,
}: { client?: ReturnType<typeof createClient> } = {}) {
  const client = useRef(injected ?? createClient()).current;
  const [tab, setTab] = useState<Tab>("home"),
    [home, setHome] = useState<Home>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<MiniError>(),
    [out, setOut] = useState(false),
    [kind, setKind] = useState<Kind>("point-ledger"),
    [page, setPage] = useState<Page>(),
    [recoverRedemptionId, setRecoverRedemptionId] = useState<string>(),
    [panel, setPanel] = useState<
      "games" | "language" | "help" | "platformAccount" | null
    >(null),
    [platformVerified, setPlatformVerified] = useState<boolean>(),
    [device, setDevice] = useState<Locale | undefined>(() =>
      readPreference(miniBrand.appKey),
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
      setHome(await client.home());
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
    if (next === "membership" && platformVerified === undefined)
      void client
        .platforms?.()
        .then((r) =>
          setPlatformVerified(
            r.items.some((p) => p.identity?.status === "verified"),
          ),
        )
        .catch(() => {});
    if (next === "rewards" || next === "invite") {
      const history = k ?? (next === "invite" ? "referrals" : "point-ledger");
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
  const memberOn = !!(home?.member?.enabled && home.member.available);
  const refreshHome = async () => {
    const h = await client.home();
    setHome(h);
    return h;
  };
  const near = memberOn && nearLevelUp(home?.member);
  const goEarn = () => select("membership");
  const go = (to: string) => (to === "bind" ? openBind() : select(to as Tab));
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
          {tab === "home" && (
            <>
              <div data-testid="today-focus">
                <MemberCard
                  member={home.member}
                  locale={locale}
                  onEarn={near ? goEarn : undefined}
                />
                <button
                  className="text-button card-link"
                  onClick={() => select("membership")}
                >
                  {t("membership")} <span aria-hidden="true">→</span>
                </button>
              </div>
              <h2 className="section-title">{t("todayActions")}</h2>
              {isKnownPrimary(home.primaryAction) ? (
                <BackendPrimary t={t} action={home.primaryAction} go={go} />
              ) : !memberOn ? (
                <div className="primary-action">
                  <div>
                    <strong>{t("actionBind")}</strong>
                    <small>{t("actionBindBody")}</small>
                  </div>
                  <button onClick={openBind}>{t("bindCta")}</button>
                </div>
              ) : (
                <CheckinPanel
                  doneView={<DailyDone t={t} go={go} />}
                  t={t}
                  member={home.member}
                  checkin={client.memberCheckin}
                  refresh={refreshHome}
                  onInvite={() => select("invite")}
                  onBenefits={() => select("membership")}
                />
              )}
              <section className="points-strip" aria-label={t("points")}>
                <div>
                  <small>{t("points")}</small>
                  <strong>
                    {balance} <span>{t("pointsUnit")}</span>
                  </strong>
                  {home.points.expiringSoon &&
                    home.points.expiringSoon !== "0" && (
                      <em>
                        {t("pointsExpiring", {
                          amount: formatPoints(
                            home.points.expiringSoon,
                            locale,
                          ),
                        })}
                      </em>
                    )}
                </div>
                <button onClick={() => select("rewards")}>
                  {t("rewardCentre")}
                </button>
              </section>
              <div className="secondary-actions">
                <button onClick={() => select("invite")}>
                  <span className="tile-icon">
                    <Icon name="users" />
                  </span>
                  <span>
                    <strong>{t("actionInvite")}</strong>
                    <small>{t("inviteActionBody")}</small>
                  </span>
                  <span className="go">{t("inviteCta")}</span>
                </button>
                {memberOn ? (
                  <button onClick={openBind}>
                    <span className="tile-icon">
                      <Icon name="link" />
                    </span>
                    <span>
                      <strong>{t("actionBind")}</strong>
                      <small>{t("actionBindBody")}</small>
                    </span>
                    <span className="go">
                      <Icon name="arrow" />
                    </span>
                  </button>
                ) : (
                  <button onClick={() => select("membership")}>
                    <span className="tile-icon">
                      <Icon name="growth" />
                    </span>
                    <span>
                      <strong>{t("growthWays")}</strong>
                      <small>{t("growthWaysBody")}</small>
                    </span>
                    <span className="go">
                      <Icon name="arrow" />
                    </span>
                  </button>
                )}
              </div>
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
              {memberOn && (
                <CheckinPanel
                  t={t}
                  member={home.member}
                  checkin={client.memberCheckin}
                  refresh={refreshHome}
                  onInvite={() => select("invite")}
                  onBenefits={() => select("membership")}
                />
              )}
              <h2 className="section-title">{t("growthWays")}</h2>
              <GrowthWays
                t={t}
                member={home.member}
                memberOn={memberOn}
                platformVerified={platformVerified}
                onCheckin={() =>
                  window.scrollTo?.({ top: 0, behavior: "smooth" })
                }
                onInvite={() => select("invite")}
                onBind={openBind}
              />
              <section className="card compact-list">
                <div className="placeholder-row">
                  <span>{t("currentBenefits")}</span>
                  <small>{t("soon")}</small>
                </div>
                <div className="placeholder-row">
                  <span>
                    {memberOn && home.member?.nextThreshold
                      ? t("levelBenefits", {
                          level: String((home.member.level ?? 0) + 1),
                        })
                      : t("nextBenefits")}
                  </span>
                  <small>{t("soon")}</small>
                </div>
              </section>
              <p className="aside-note">{t("growthDifference")}</p>
            </>
          )}
          {tab === "games" && (
            <>
              <p className="page-intro">{t("gameBody")}</p>
              <div className="game-grid">
                {(["wheel", "chest", "scratch", "cards"] as const).map(
                  (k, i) => (
                    <section className="card game-tile" key={k}>
                      <span className="game-glyph" aria-hidden="true">
                        {["◉", "◇", "▧", "♧"][i]}
                      </span>
                      <h2>{t(k)}</h2>
                      <button disabled>{t("soon")}</button>
                    </section>
                  ),
                )}
              </div>
            </>
          )}
          {tab === "activities" && (
            <>
              <p className="page-intro">{t("activityIntro")}</p>
              <button
                className="activity-invite"
                onClick={() => select("invite")}
              >
                {t("friends")} <span>→</span>
              </button>
              <section className="card launching">
                <h2>{t("activitiesLaunching")}</h2>
                <p className="muted">{t("activitiesLaunchingBody")}</p>
              </section>
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
                  {t("redeemCentre")}
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
                />
              )}
              <details className="card">
                <summary>{t("earnPoints")}</summary>
                <p>{t("earnPointsBody")}</p>
                <button onClick={() => select("activities")}>
                  {t("activities")}
                </button>
              </details>
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
                {(["entitlements"] as const).map((k) => (
                  <div className="placeholder-row" key={k}>
                    <span>{t(k)}</span>
                    <small>{t("soon")}</small>
                  </div>
                ))}
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
              aria-label={t(panel === "games" ? "gameTitle" : panel)}
            >
              <div className="card-top">
                <h2>{t(panel === "games" ? "gameTitle" : panel)}</h2>
                <button className="text-button" onClick={() => setPanel(null)}>
                  {t("close")}
                </button>
              </div>
              {panel === "platformAccount" ? (
                <PlatformAccounts client={client} locale={locale} />
              ) : panel === "games" ? (
                <>
                  <p className="muted">{t("gameBody")}</p>
                  {(["wheel", "chest", "scratch", "cards"] as const).map(
                    (k) => (
                      <div className="placeholder-row" key={k}>
                        <span>{t(k)}</span>
                        <small>{t("soon")}</small>
                      </div>
                    ),
                  )}
                </>
              ) : panel === "language" ? (
                <>
                  <div className="language-options">
                    {supportedUiLocales.map((l) => (
                      <button
                        key={l}
                        aria-pressed={locale === l}
                        onClick={() => {
                          savePreference(miniBrand.appKey, l);
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
                item === tab ||
                (item === "me" && (tab === "rewards" || tab === "invite"))
                  ? "page"
                  : undefined
              }
              disabled={busy}
              onClick={() => select(item)}
            >
              <Icon name={["home", "badge", "spark", "game", "user"][i]} />
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
