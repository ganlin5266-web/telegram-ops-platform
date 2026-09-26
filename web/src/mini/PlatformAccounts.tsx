import React, { useEffect, useRef, useState } from "react";
import {
  MiniError,
  type MiniClient,
  type MiniPlatform,
  type PlatformIdentity,
} from "./client";
import { translate, formatDate, type Locale, type Key } from "./i18n";
export default function PlatformAccounts({
  client,
  locale,
}: {
  client: MiniClient;
  locale: Locale;
}) {
  const [items, setItems] = useState<MiniPlatform[]>([]),
    [history, setHistory] = useState<PlatformIdentity[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [uid, setUid] = useState(""),
    [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<MiniError>();
  const pending = useRef<
    { platformId: string; uid: string; key: string } | undefined
  >(undefined);
  const t = (k: Key) => translate(locale, k);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof MiniError ? e : new MiniError("request"));
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const [p, h] = await Promise.all([client.platforms(), client.identities()]);
    setItems(p.items);
    setHistory(h.items);
    setCursor(h.nextCursor);
  }
  useEffect(() => {
    void run(refresh);
  }, [client]);
  async function submit(platformId: string) {
    if (busy) return;
    await run(async () => {
      if (
        !pending.current ||
        pending.current.platformId !== platformId ||
        pending.current.uid !== uid
      )
        pending.current = { platformId, uid, key: crypto.randomUUID() };
      await client.submitPlatform(platformId, uid, pending.current.key);
      pending.current = undefined;
      setUid("");
      setSelected("");
      await refresh();
    });
  }
  const statusKey = (s?: string): Key =>
    (
      ({
        pending: "uidPending",
        verified: "uidVerified",
        rejected: "uidRejected",
        conflict: "uidConflict",
        revoked: "uidRevoked",
      }) as Record<string, Key>
    )[s ?? ""] ?? "uidUnbound";
  return (
    <section className="card platform-accounts">
      <div className="card-top">
        <h2>{t("platformAccount")}</h2>
        <button
          className="text-button"
          disabled={busy}
          onClick={() => void run(refresh)}
        >
          {t("uidRefresh")}
        </button>
      </div>
      <p className="muted">{t("uidIntro")}</p>
      {!busy && items.length === 0 && <p>{t("uidNoPlatforms")}</p>}
      {items.map((p) => (
        <article className="platform-account" key={p.id}>
          <h3>{p.display_name}</h3>
          <span className="badge">{t(statusKey(p.identity?.status))}</span>
          {p.identity && <p>{p.identity.uidMasked}</p>}
          {p.identity?.status === "pending" && <p>{t("uidPendingHelp")}</p>}
          {p.identity?.status === "verified" && (
            <p className="muted">{t("uidVerifiedHelp")}</p>
          )}
          {p.identity?.status === "conflict" && <p>{t("uidConflictHelp")}</p>}
          {p.identity?.status === "rejected" && <p>{t("uidRejectedHelp")}</p>}
          {p.status !== "active" || p.verification_method !== "manual_admin" ? (
            <p>{t("uidUnavailable")}</p>
          ) : !["pending", "verified"].includes(p.identity?.status ?? "") ? (
            <>
              {selected === p.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submit(p.id);
                  }}
                >
                  <label>
                    {t("uidLabel")}
                    <input
                      autoComplete="off"
                      value={uid}
                      maxLength={128}
                      disabled={busy}
                      onChange={(e) => setUid(e.target.value)}
                      required
                    />
                  </label>
                  <p className="muted">{t("uidPrivacy")}</p>
                  <button disabled={busy || !uid.trim()}>
                    {t("uidSubmit")}
                  </button>
                </form>
              ) : (
                <button
                  disabled={busy}
                  onClick={() => {
                    setSelected(p.id);
                    setUid("");
                    pending.current = undefined;
                  }}
                >
                  {t(p.identity ? "uidResubmit" : "uidBind")}
                </button>
              )}
            </>
          ) : null}
        </article>
      ))}
      <h3>{t("uidHistory")}</h3>
      {history.map((r) => (
        <div className="record" key={r.id}>
          <div>
            <strong>{r.platformName}</strong>
            <small>{r.uidMasked}</small>
            <small>{formatDate(r.submittedAt, locale)}</small>
          </div>
          <span>{t(statusKey(r.status))}</span>
        </div>
      ))}
      {cursor && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const h = await client.identities(cursor);
              setHistory([...history, ...h.items]);
              setCursor(h.nextCursor);
            })
          }
        >
          {t("more")}
        </button>
      )}
      {busy && <p role="status">{t("loading")}</p>}
      {error && <p role="alert">{t(error.kind)}</p>}
    </section>
  );
}
