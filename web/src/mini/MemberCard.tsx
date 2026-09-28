import { useState } from "react";
import type { MemberSummary } from "./client";
export function MemberCard({
  member,
  locale,
  history,
  checkin,
  onUpdated,
}: {
  member?: MemberSummary;
  locale: string;
  history?: (after?: string) => Promise<any>;
  checkin?: () => Promise<unknown>;
  onUpdated?: () => Promise<void>;
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
      <section className="member-pass">
        <h2>{zh ? "会员成长尚未启用" : "Member Growth is not enabled"}</h2>
        <p>
          {zh
            ? "开通后将在这里展示你的真实等级和成长值。"
            : "Your level and Growth will appear here when available."}
        </p>
      </section>
    );
  return (
    <section className="member-pass">
      <div className="pass-top">
        <span>{zh ? "会员等级" : "Member level"}</span>
        <strong>
          LV{member.level} · {member.levelName}
        </strong>
      </div>
      <h2>{member.growth} Growth</h2>
      <progress
        max={100}
        value={member.progress}
        aria-label={zh ? "升级进度" : "Level progress"}
      />
      <p>
        {member.nextThreshold
          ? zh
            ? `下一等级门槛 ${member.nextThreshold}`
            : `Next level: ${member.nextThreshold}`
          : zh
            ? "已达最高等级，成长值继续累计"
            : "Highest level reached. Growth continues to accumulate."}
      </p>
      {member.protected && (
        <p>{zh ? "当前等级受到保护" : "Your current level is protected"}</p>
      )}
      <p>
        {zh ? "今日已获得" : "Earned today"}：{member.todayGrowth} /{" "}
        {member.dailyCap}
      </p>
      {error && <p role="alert">{error}</p>}
      {checkin && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await checkin();
              await onUpdated?.();
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
      )}
      {history && (
        <button disabled={busy} onClick={() => void load()}>
          {zh ? "成长记录" : "Growth history"}
        </button>
      )}
      {loaded && !rows.length && (
        <p>{zh ? "暂无成长记录" : "No Growth history yet"}</p>
      )}
      {rows.map((r) => (
        <p key={r.id}>
          {r.business_date} · {r.delta} Growth
        </p>
      ))}
      {next && (
        <button disabled={busy} onClick={() => void load(next)}>
          {zh ? "加载更多" : "Load more"}
        </button>
      )}
    </section>
  );
}
