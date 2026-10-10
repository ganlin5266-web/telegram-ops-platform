import { useState } from "react";
import type { MemberSummary } from "./client";

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
  const zh = locale === "zh-CN",
    [rows, setRows] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false);
  async function load(after?: string) {
    setBusy(true);
    try {
      const r = await history?.(after);
      setRows(after ? [...rows, ...r.items] : r.items);
      setNext(r.next);
      setLoaded(true);
    } catch {
      setError(zh ? "暂时无法读取，请重试" : "Unable to load. Please retry.");
    } finally {
      setBusy(false);
    }
  }
  if (!member?.enabled || !member.available)
    return (
      <section className="member-pass pending">
        <span className="pass-chip">{zh ? "会员" : "Member"}</span>
        <h2>{zh ? "会员成长尚未启用" : "Member Growth is not enabled"}</h2>
        <p>
          {zh
            ? "开通后将在这里展示你的真实等级和成长值。"
            : "Your level and Growth will appear here when available."}
        </p>
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
        aria-label={zh ? "升级进度" : "Level progress"}
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
            ? zh
              ? `还差 ${gap} Growth 升级 LV${nextLevel}`
              : `${gap} Growth to reach LV${nextLevel}`
            : zh
              ? `已达到 LV${nextLevel} 门槛，等待等级更新`
              : `LV${nextLevel} threshold reached, level update pending`
          : zh
            ? "已达最高等级，成长值继续累计"
            : "Highest level reached. Growth continues to accumulate."}
      </p>
      {onEarn && gap && (
        <button className="pass-earn" onClick={onEarn}>
          {zh ? "去赚 Growth" : "Earn Growth"}
        </button>
      )}
      {member.todayGrowth != null && (
        <p className="pass-today">
          {zh ? "今日获得" : "Earned today"} +{member.todayGrowth} Growth
        </p>
      )}
      {history && member.protected && (
        <p className="pass-note">
          {zh ? "你的会员等级已保留" : "Your member level has been kept"}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {history && (
        <button
          className="pass-link"
          disabled={busy}
          onClick={() => void load()}
        >
          {zh ? "成长记录" : "Growth history"}
        </button>
      )}
      {loaded && !rows.length && (
        <p>{zh ? "暂无成长记录" : "No Growth history yet"}</p>
      )}
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
          {zh ? "加载更多" : "Load more"}
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
  const zh = locale === "zh-CN",
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(false);
  return (
    <div className="primary-action">
      <div>
        <strong>{title}</strong>
        <small>{body}</small>
      </div>
      {error && <p role="alert">{error}</p>}
      {done && (
        <p role="status">
          {zh
            ? "签到已提交，成长值已刷新"
            : "Check-in submitted. Growth refreshed."}
        </p>
      )}
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
            setError(
              zh
                ? "签到暂未完成，请重试"
                : "Check-in was not completed. Please retry.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {zh ? "每日签到" : "Daily check-in"}
      </button>
    </div>
  );
}
