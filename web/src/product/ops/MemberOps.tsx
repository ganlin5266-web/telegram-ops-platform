import { useState } from "react";
import { fmt } from "./model";
import { UserTable, type UserRow } from "./User360";

export type MemberOpsData = {
  members: UserRow[] | null;
  levels:
    | {
        level: number;
        name: string | null;
        threshold: string;
        benefits?: string[] | null;
      }[]
    | null;
  rules:
    | {
        action: string;
        condition: string;
        growth: string;
        status: "published" | "draft";
        advanced?: [string, string][];
      }[]
    | null;
  /** Platform deposit tiers, when the rule uses them. */
  tiers?: { range: string; growth: string }[] | null;
  rulesAdvanced?: [string, string][];
  benefitsAvailable: false;
};
export const memberTabs = [
  "会员用户",
  "等级设置",
  "Growth 规则",
  "权益设置",
] as const;
export type MemberTab = (typeof memberTabs)[number];
const benefitSlots = ["游戏次数", "Points Bonus", "周奖励", "会员活动"];

export default function MemberOps({
  data,
  tab: ctl,
  onTab,
  onOpenUser,
}: {
  data: MemberOpsData;
  tab?: MemberTab;
  onTab?: (t: MemberTab) => void;
  onOpenUser?: (id: string) => void;
}) {
  const [own, setOwn] = useState<MemberTab>("会员用户");
  const tab = ctl ?? own;
  const setTab = onTab ?? setOwn;
  return (
    <div className="ops">
      <div className="ops-tabs domain" role="tablist" aria-label="会员运营">
        {memberTabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "会员用户" && (
        <section className="ops-panel">
          {!data.members ? (
            <p className="ops-pending-note">会员列表待接入</p>
          ) : !data.members.length ? (
            <p className="ops-empty">
              还没有会员：用户绑定平台账号并启用会员后会出现在这里
            </p>
          ) : (
            <UserTable users={data.members} onRow={(u) => onOpenUser?.(u.id)} />
          )}
        </section>
      )}
      {tab === "等级设置" &&
        (!data.levels ? (
          <p className="ops-pending-note">等级规则待接入</p>
        ) : (
          <ol className="ops-ladder" aria-label="等级阶梯">
            {[...data.levels]
              .sort((a, b) => a.level - b.level)
              .map((l, i) => (
                <li key={l.level} style={{ ["--step" as string]: i }}>
                  <b>LV{l.level}</b>
                  <span>{l.name ?? "未命名"}</span>
                  <strong>
                    {fmt({ s: "value", v: l.threshold })}
                    <small> Growth</small>
                  </strong>
                  {l.benefits?.length ? (
                    l.benefits.slice(0, 3).map((x) => <p key={x}>{x}</p>)
                  ) : (
                    <em className="ops-badge pending">权益待接入</em>
                  )}
                </li>
              ))}
          </ol>
        ))}
      {tab === "Growth 规则" && (
        <section className="ops-panel">
          {!data.rules ? (
            <p className="ops-pending-note">Growth 规则待接入</p>
          ) : (
            <>
              <div className="ops-scroll">
                <table className="ops-table ops-rule-table">
                  <thead>
                    <tr>
                      <th>来源</th>
                      <th>条件摘要</th>
                      <th>Growth</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rules.map((r) => (
                      <tr key={r.action}>
                        <td>{r.action}</td>
                        <td>{r.condition}</td>
                        <td>
                          <b>{r.growth}</b>
                        </td>
                        <td>
                          <span
                            className={`ops-badge ${r.status === "published" ? "" : "pending"}`}
                          >
                            {r.status === "published"
                              ? "已发布 · 只读"
                              : "草稿"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.tiers && (
                <>
                  <h3 className="ops-sub">平台充值档位</h3>
                  <table className="ops-table">
                    <thead>
                      <tr>
                        <th>业务日充值</th>
                        <th>Growth</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.tiers.map((t) => (
                        <tr key={t.range}>
                          <td>{t.range}</td>
                          <td>{t.growth}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              {data.rulesAdvanced && (
                <details className="ops-details">
                  <summary>高级详情</summary>
                  <dl className="ops-dl">
                    {data.rulesAdvanced.map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>
                          <code>{v}</code>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
            </>
          )}
        </section>
      )}
      {tab === "权益设置" && (
        <section className="ops-panel">
          <p className="ops-info" role="status">
            权益功能待接入：以下仅为设置结构，全部未生效，用户侧不可见。
          </p>
          <div className="ops-scroll">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>权益</th>
                  {[1, 2, 3, 4, 5].map((l) => (
                    <th key={l}>LV{l}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {benefitSlots.map((b) => (
                  <tr key={b}>
                    <td>{b}</td>
                    {[1, 2, 3, 4, 5].map((l) => (
                      <td key={l} className="ops-pending">
                        未生效
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
