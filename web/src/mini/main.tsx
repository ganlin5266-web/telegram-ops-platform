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
  homeState,
  type Locale,
  type Key,
} from "./i18n";
import PlatformAccounts from "./PlatformAccounts";
import "./style.css";
const tabs = ["home", "activities", "rewards", "invite", "me"] as const;
type Tab = (typeof tabs)[number];
type Kind = "point-ledger" | "referrals" | "redemptions";
const templates = [
  ["newcomer", "✧", "newcomerBody"],
  ["daily", "☀", "dailyBody"],
  ["free", "◇", "freeBody"],
  ["friends", "↗", "inviteBody"],
] as const;
export function MiniApp() {
  const client = useRef(createClient()).current;
  const [tab, setTab] = useState<Tab>("home"),
    [home, setHome] = useState<Home>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<MiniError>(),
    [out, setOut] = useState(false),
    [kind, setKind] = useState<Kind>("point-ledger"),
    [page, setPage] = useState<Page>(),
    [panel, setPanel] = useState<
      "games" | "language" | "help" | "platformAccount" | null
    >(null),
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
                ].includes(r.status)
                  ? r.status
                  : r.status
                    ? "recorded"
                    : "posted") as Key,
              )}
            </small>
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
  const catalogue = (
    <div className="activity-grid">
      {templates.map(([key, icon, body]) => (
        <article className="card activity-card" key={key}>
          <div className="card-top">
            <span className="tile-icon" aria-hidden="true">
              {icon}
            </span>
            <span className="badge">{t("soon")}</span>
          </div>
          <h2>{t(key)}</h2>
          <p className="muted">{t(body)}</p>
          <small>{t("schedule")}</small>
          <button disabled className="coming-button">
            {t("upcoming")}
          </button>
        </article>
      ))}
    </div>
  );
  const balance = formatPoints(home?.points.balance, locale);
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
              <section className="hero focus-card" data-testid="today-focus">
                <span className="pill">{t("focus")}</span>
                <span className="hero-art" aria-hidden="true">
                  ✧
                </span>
                <h2>
                  {t(
                    homeState(home) === "empty_state" ? "ready" : "returnTitle",
                  )}
                </h2>
                <p>
                  {t(
                    homeState(home) === "empty_state"
                      ? "readyBody"
                      : "returnBody",
                  )}
                </p>
                <button onClick={() => select("activities")}>
                  {t("focusCta")} <span aria-hidden="true">→</span>
                </button>
              </section>
              <h2 className="section-title">{t("summary")}</h2>
              <div className="summary">
                <button onClick={() => select("rewards")}>
                  <strong>{balance}</strong>
                  <span>{t("points")}</span>
                </button>
                <button onClick={() => select("invite")}>
                  <strong>{formatPoints(home.invitedCount, locale)}</strong>
                  <span>{t("friends")}</span>
                </button>
                <button onClick={() => select("rewards", "redemptions")}>
                  <strong>{formatPoints(home.redemptionCount, locale)}</strong>
                  <span>{t("myRedeem")}</span>
                </button>
              </div>
              <h2 className="section-title">{t("quick")}</h2>
              <div className="quick-grid">
                {(
                  [
                    ["activityCentre", "activities", "✦"],
                    ["rewardCentre", "rewards", "◇"],
                    ["games", "games", "▧"],
                    ["friends", "invite", "↗"],
                  ] as const
                ).map(([label, target, icon]) => (
                  <button
                    key={label}
                    onClick={() =>
                      target === "games" ? setPanel("games") : select(target)
                    }
                  >
                    <span className="tile-icon" aria-hidden="true">
                      {icon}
                    </span>
                    <strong>{t(label)}</strong>
                    {target === "games" && <small>{t("soon")}</small>}
                  </button>
                ))}
              </div>
              <h2 className="section-title">{t("recommend")}</h2>
              <div className="recommend">
                {templates.slice(0, 3).map(([key, icon]) => (
                  <div key={key}>
                    <span aria-hidden="true">{icon}</span>
                    <strong>{t(key)}</strong>
                    <small>{t("soon")}</small>
                  </div>
                ))}
              </div>
            </>
          )}
          {tab === "activities" && (
            <>
              <p className="page-intro">{t("activityIntro")}</p>
              {catalogue}
              <section className="card">
                <h2>{t("future")}</h2>
                {(["platformTask", "milestone"] as const).map((k) => (
                  <div className="placeholder-row" key={k}>
                    <span>{t(k)}</span>
                    <small>{t("soon")}</small>
                  </div>
                ))}
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
                <button disabled>
                  {t("redeemCentre")}
                  <small>{t("soon")}</small>
                </button>
                <button
                  aria-pressed={kind === "redemptions"}
                  onClick={() => historySelect("redemptions")}
                >
                  {t("myRedeem")}
                </button>
              </div>
              {history}
            </>
          )}
          {tab === "invite" && (
            <>
              <section className="hero">
                <span className="pill">{t("friends")}</span>
                <h2>{t("inviteTitle")}</h2>
                <p>{t("inviteLead")}</p>
                <button disabled>{t("inviteSoon")}</button>
              </section>
              <div className="summary invite-summary">
                <div>
                  <strong>{formatPoints(home.invitedCount, locale)}</strong>
                  <span>{t("invited")}</span>
                </div>
                <div>
                  <strong>—</strong>
                  <span>{t("pendingReward")}</span>
                  <small>{t("rulesUnpublished")}</small>
                </div>
              </div>
              <section className="card">
                <ol className="journey">
                  {(["journey1", "journey2", "journey3"] as const).map((k) => (
                    <li key={k}>{t(k)}</li>
                  ))}
                </ol>
                <p className="muted">{t("journeyNote")}</p>
              </section>
              {history}
              <div className="placeholder-row card">
                <span>{t("rules")}</span>
                <small>{t("soon")}</small>
              </div>
            </>
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
              aria-current={item === tab ? "page" : undefined}
              disabled={busy}
              onClick={() => select(item)}
            >
              <span aria-hidden="true">{["⌂", "✦", "◇", "↗", "○"][i]}</span>
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
