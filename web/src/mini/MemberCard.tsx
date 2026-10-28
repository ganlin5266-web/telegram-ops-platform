import { useState } from "react";
import type { MemberSummary } from "./client";
import { translate, type Key, type Locale } from "./i18n";

// Growth values are integer strings from the server; BigInt avoids precision loss.
function growthGap(growth?: string, next?: string | null): string | null {
  if (!next || !growth || !/^\d+$/.test(growth) || !/^\d+$/.test(next))
    return null;
  const gap = BigInt(next) - BigInt(growth);
  return gap > 0n ? gap.toString() : null;
}

// Member card shows status only: Level, Growth, progress, next level.
// Actions such as check-in live in the page's action area, not here.
export function MemberCard({
  member,
  locale,
  history,
  onEarn,
}: {
  member?: MemberSummary;
  locale: string;
  history?: (after?: string) => Promise<any>;
  onEarn?: () => void;
}) {
  const t = (k: Key, values?: Record<string, string>) =>
    translate(locale as Locale, k, values);
  const [rows, setRows] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false);
  async function load(after?: string) {
    setBusy(true);
    setError("");
    try {
      const r = await history?.(after);
      setRows(after ? [...rows, ...r.items] : r.items);
      setNext(r.next);
      setLoaded(true);
    } catch {
      setError(t("request"));
    } finally {
      setBusy(false);
    }
  }
  if (!member?.enabled || !member.available)
    return (
      <section className="member-pass pending">
        <span className="pass-chip">{t("membership")}</span>
        <h2>{t(member?.enabled ? "p0MemberPending" : "p0MemberDisabled")}</h2>
        <p>{t("p0MemberDisabledBody")}</p>
      </section>
    );
  const gap = growthGap(member.growth, member.nextThreshold);
  const pct = Math.max(0, Math.min(100, Number(member.progress) || 0));
  const nextLevel = (member.level ?? 0) + 1;
  return (
    <section className={`member-pass${onEarn ? " near" : ""}`}>
      <strong className="pass-level">
        LV{member.level} · {member.levelName}
      </strong>
      <div className="pass-growth">
        <strong>{member.growth ?? "—"}</strong>
        {member.nextThreshold ? (
          <span>/ {member.nextThreshold} Growth</span>
        ) : (
          <span>Growth</span>
        )}
      </div>
      <div
        className="pass-bar"
        role="progressbar"
        aria-label={t("p0LevelProgress")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <span
          style={{ width: `${pct}%` }}
          className={pct > 0 ? "filled" : ""}
        />
      </div>
      <p className="pass-next">
        {member.nextThreshold
          ? gap
            ? t("p2GapTo", { gap, level: String(nextLevel) })
            : t("p0LevelPending", { level: String(nextLevel) })
          : t("p0HighestLevel")}
      </p>
      {onEarn && gap && (
        <button className="pass-earn" onClick={onEarn}>
          {t("p2EarnGrowth")}
        </button>
      )}
      {member.todayGrowth != null && (
        <p className="pass-today">
          {t("p0EarnedToday")} +{member.todayGrowth} Growth
        </p>
      )}
      {history && member.protected && (
        <p className="pass-note">{t("levelProtected")}</p>
      )}
      {error && <p role="alert">{error}</p>}
      {history && (
        <button
          className="pass-link"
          disabled={busy}
          onClick={() => void load()}
        >
          {t("p0GrowthHistory")}
        </button>
      )}
      {loaded && !rows.length && <p>{t("p0GrowthEmpty")}</p>}
      {rows.length > 0 && (
        <ul className="pass-history">
          {rows.map((r) => (
            <li key={r.id}>
              {r.business_date} · {r.delta} Growth
            </li>
          ))}
        </ul>
      )}
      {next && (
        <button
          className="pass-link"
          disabled={busy}
          onClick={() => void load(next)}
        >
          {t("more")}
        </button>
      )}
    </section>
  );
}

// Check-in is an action, independent of the card. Feedback is transient only;
// the page never persists or infers "checked in today" on the client.
export function CheckinAction({
  locale,
  checkin,
  onUpdated,
  title,
  body,
}: {
  locale: string;
  checkin: () => Promise<unknown>;
  onUpdated?: () => Promise<void>;
  title: string;
  body: string;
}) {
  const t = (k: Key) => translate(locale as Locale, k);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(false);
  return (
    <div className="primary-action">
      <div>
        <strong>{title}</strong>
        <small>{body}</small>
      </div>
      {error && <p role="alert">{error}</p>}
      {done && <p role="status">{t("p0CheckinSubmitted")}</p>}
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          setDone(false);
          try {
            await checkin();
            await onUpdated?.();
            setDone(true);
          } catch {
            setError(t("p2CheckinFailed"));
          } finally {
            setBusy(false);
          }
        }}
      >
        {t("p0CheckinGrowth")}
      </button>
    </div>
  );
}
