import { useState } from "react";
import { fmt, type Cell } from "./model";
import { Value } from "./OpsCenter";

export type PlatformStatus =
  "verified" | "pending" | "conflict" | "rejected" | "revoked";
export const platformStatusText: Record<PlatformStatus, string> = {
  verified: "已认证",
  pending: "审核中",
  conflict: "账号冲突",
  rejected: "未通过",
  revoked: "已解除",
};
export type UserRow = {
  id: string;
  name: string;
  handle: string;
  level: Cell;
  growth: Cell;
  points: Cell;
  platform: string | null;
  platformStatus?: PlatformStatus | null;
  /** One Member, many Platform identities (same Market). Never duplicated into several users. */
  platforms?: PlatformLink[];
  lastActive: string | null;
  status: "active" | "blocked" | "pending";
};
export type PlatformLink = {
  name: string;
  status: PlatformStatus | "unbound";
  uid?: string;
  boundAt?: string;
  lastDay?: string;
  disabled?: boolean;
};
export type User360Data = UserRow & {
  /** Market context of this member (read-only in User 360). */
  market?: string;
  telegramId: string;
  joinedAt: string;
  sections: Record<
    "会员" | "Growth" | "Points" | "平台账号" | "邀请" | "活动" | "游戏",
    [string, Cell][] | null
  >;
  advanced?: [string, string][];
};
export const statusText = {
  active: "正常",
  blocked: "已停用",
  pending: "待审核",
};
const lv = (c: Cell) => (c.s === "value" ? `LV${c.v}` : fmt(c));
export const platformLabel = (u: UserRow) => {
  if (u.platforms) {
    const bound = u.platforms.filter((p) => p.status !== "unbound");
    return !bound.length
      ? "未绑定"
      : bound
          .map(
            (p) =>
              `${p.name} · ${p.status === "unbound" ? "未绑定" : platformStatusText[p.status]}`,
          )
          .join("，");
  }
  return !u.platform
    ? "未绑定"
    : u.platformStatus
      ? `${u.platform} · ${platformStatusText[u.platformStatus]}`
      : u.platform;
};

export function UserTable({
  users,
  onRow,
}: {
  users: UserRow[];
  onRow: (u: UserRow) => void;
}) {
  return (
    <div className="ops-scroll">
      <table className="ops-table ops-users">
        <thead>
          <tr>
            <th>用户</th>
            <th>Level</th>
            <th>Growth</th>
            <th>Points</th>
            <th>Platform</th>
            <th>最近活跃</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr
              key={u.id}
              tabIndex={0}
              onClick={() => onRow(u)}
              onKeyDown={(e) => e.key === "Enter" && onRow(u)}
            >
              <td>
                <b>{u.name}</b>
                <small>{u.handle}</small>
              </td>
              <td>{lv(u.level)}</td>
              <td>{fmt(u.growth)}</td>
              <td>{fmt(u.points)}</td>
              <td>{platformLabel(u)}</td>
              <td>{u.lastActive ?? "—"}</td>
              <td>
                <span className={`ops-badge ${u.status}`}>
                  {statusText[u.status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UserList({
  users,
  onOpen,
}: {
  users: UserRow[];
  onOpen: (id: string) => void;
}) {
  const [q, setQ] = useState(""),
    [level, setLevel] = useState(""),
    [platform, setPlatform] = useState(""),
    [status, setStatus] = useState("");
  const [peek, setPeek] = useState<UserRow | null>(null);
  const rows = users.filter(
    (u) =>
      (!q ||
        `${u.name}${u.handle}${u.id}`
          .toLowerCase()
          .includes(q.toLowerCase())) &&
      (!level || (u.level.s === "value" && u.level.v === level)) &&
      (!platform ||
        (u.platforms
          ? u.platforms.some(
              (p) => p.name === platform && p.status !== "unbound",
            )
          : u.platform === platform)) &&
      (!status || u.status === status),
  );
  const filtered = !!(q || level || platform || status);
  return (
    <section className="ops-panel">
      <div className="ops-filter flat">
        <input
          className="ops-search"
          aria-label="搜索用户"
          placeholder="搜索用户名 / Telegram / UID"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          aria-label="Level"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          <option value="">全部等级</option>
          {[1, 2, 3, 4, 5].map((l) => (
            <option key={l} value={String(l)}>
              LV{l}
            </option>
          ))}
        </select>
        <select
          aria-label="关联 Platform"
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
        >
          <option value="">全部关联 Platform</option>
          {[
            ...new Set(
              users
                .flatMap((u) =>
                  u.platforms ? u.platforms.map((p) => p.name) : [u.platform],
                )
                .filter(Boolean),
            ),
          ].map((p) => (
            <option key={p!}>{p}</option>
          ))}
        </select>
        <select
          aria-label="状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">全部状态</option>
          {Object.entries(statusText).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {!rows.length ? (
        <p className="ops-empty">
          {filtered
            ? "没有符合条件的用户，试试清空搜索或筛选条件"
            : "当前 Bot 还没有用户，用户启动 Bot 后会出现在这里"}
        </p>
      ) : (
        <UserTable users={rows} onRow={setPeek} />
      )}
      {peek && (
        <aside className="ops-drawer" role="dialog" aria-label="用户快速查看">
          <div className="ops-drawer-head">
            <h3>{peek.name}</h3>
            <button
              className="ops-ghost"
              aria-label="关闭"
              onClick={() => setPeek(null)}
            >
              ×
            </button>
          </div>
          <dl className="ops-dl">
            <div>
              <dt>Level</dt>
              <dd>{lv(peek.level)}</dd>
            </div>
            <div>
              <dt>Growth</dt>
              <dd>{fmt(peek.growth)}</dd>
            </div>
            <div>
              <dt>Points</dt>
              <dd>{fmt(peek.points)}</dd>
            </div>
            <div>
              <dt>平台</dt>
              <dd>{platformLabel(peek)}</dd>
            </div>
            <div>
              <dt>最近活跃</dt>
              <dd>{peek.lastActive ?? "—"}</dd>
            </div>
          </dl>
          <button
            className="ops-primary"
            onClick={() => {
              setPeek(null);
              onOpen(peek.id);
            }}
          >
            打开 User 360
          </button>
        </aside>
      )}
    </section>
  );
}

const tabs = [
  "会员",
  "Growth",
  "Points",
  "平台账号",
  "邀请",
  "活动",
  "游戏",
] as const;
export function User360({
  user,
  onBack,
  canAdjust,
  preview,
}: {
  user: User360Data;
  onBack: () => void;
  canAdjust: boolean;
  preview?: boolean;
}) {
  const [tab, setTab] = useState<(typeof tabs)[number]>("会员");
  const [confirm, setConfirm] = useState<"Growth" | "Points" | null>(null);
  const [delta, setDelta] = useState(""),
    [reason, setReason] = useState(""),
    [done, setDone] = useState("");
  const items = user.sections[tab];
  const current =
    confirm === "Growth"
      ? user.growth
      : confirm === "Points"
        ? user.points
        : null;
  const d = /^-?\d+$/.test(delta.trim()) ? BigInt(delta.trim()) : null;
  const after: Cell | null =
    current?.s === "value" && d !== null && /^-?\d+$/.test(current.v)
      ? { s: "value", v: String(BigInt(current.v) + d) }
      : null;
  const close = () => {
    setConfirm(null);
    setDelta("");
    setReason("");
  };
  return (
    <div className="ops">
      <button className="ops-ghost" onClick={onBack}>
        ← 返回用户列表
      </button>
      <section className="ops-panel">
        <div className="ops-360-top">
          <div className="ops-avatar" aria-hidden>
            {user.name.slice(0, 1)}
          </div>
          <h2>{user.name}</h2>
          <span className={`ops-badge ${user.status}`}>
            {statusText[user.status]}
          </span>
          <div className="ops-360-meta">
            <span>{user.handle}</span>
            <span>最近活跃 {user.lastActive ?? "—"}</span>
            {user.market && (
              <span className="mk-scope-now">市场 {user.market}</span>
            )}
            <span>平台 {platformLabel(user)}</span>
            <span>加入 {user.joinedAt}</span>
          </div>
        </div>
      </section>
      <div className="ops-360-value" aria-label="会员经济状态">
        <article className="lv">
          <span>Level</span>
          <strong className={`ops-value ops-${user.level.s}`}>
            {lv(user.level)}
          </strong>
        </article>
        <article>
          <span>Growth</span>
          <Value cell={user.growth} big />
        </article>
        <article>
          <span>Points</span>
          <Value cell={user.points} big />
        </article>
      </div>
      <section className="ops-panel">
        <div className="ops-tabs" role="tablist" aria-label="用户模块">
          {tabs.map((t) => (
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
        {tab === "平台账号" && user.platforms ? (
          <PlatformAccounts links={user.platforms} />
        ) : !items ? (
          <p className="ops-pending-note">{tab}数据待接入</p>
        ) : (
          <dl className="ops-dl">
            {items.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>
                  <Value cell={v} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <section className="ops-panel ops-danger">
        <div className="ops-panel-head">
          <h2>高风险操作</h2>
          <span className="ops-muted">
            需要权限与二次确认，写入流水并记录审计
          </span>
        </div>
        <div className="ops-actions">
          <button
            className="ops-danger-btn"
            disabled={!canAdjust}
            onClick={() => setConfirm("Growth")}
          >
            调整 Growth
          </button>
          <button
            className="ops-danger-btn"
            disabled={!canAdjust}
            onClick={() => setConfirm("Points")}
          >
            调整 Points
          </button>
          {!canAdjust && (
            <small className="ops-muted">你没有权限执行此操作</small>
          )}
          {done && (
            <small className="ops-preview-tag" role="status">
              {done}
            </small>
          )}
        </div>
      </section>
      {user.advanced && (
        <details className="ops-panel ops-details">
          <summary>高级诊断 · 仅管理员</summary>
          <dl className="ops-dl">
            {user.advanced.map(([k, v]) => (
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
      {confirm && current && (
        <div
          className="ops-modal"
          role="dialog"
          aria-label={`确认调整 ${confirm}`}
        >
          <div>
            <h3>调整 {confirm}</h3>
            {preview && (
              <p className="ops-preview-tag">PREVIEW：不会提交任何数据</p>
            )}
            <div className="ops-adjust">
              <dl className="ops-dl">
                <div>
                  <dt>对象</dt>
                  <dd>
                    {user.name}（{user.handle}）
                  </dd>
                </div>
                <div>
                  <dt>当前值</dt>
                  <dd>{fmt(current)}</dd>
                </div>
                <div>
                  <dt>调整后</dt>
                  <dd>{after ? fmt(after) : "—"}</dd>
                </div>
              </dl>
              <label>
                调整值（整数，可为负数）
                <input
                  aria-label="调整值"
                  inputMode="numeric"
                  value={delta}
                  onChange={(e) => setDelta(e.target.value)}
                  placeholder="例如 +50 或 -20"
                />
              </label>
              <label>
                原因
                <textarea
                  aria-label="调整原因"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                />
              </label>
            </div>
            <div className="ops-actions">
              <button onClick={close}>取消</button>
              {preview ? (
                <button
                  className="ops-primary"
                  disabled={d === null || !reason.trim()}
                  onClick={() => {
                    setDone(`PREVIEW 模拟确认：未调整 ${confirm}`);
                    close();
                  }}
                >
                  Preview 模拟确认
                </button>
              ) : (
                <button className="ops-primary" disabled>
                  在账务页提交调整
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Platform accounts inside User 360. Level/Growth stay member-level and are not repeated per Platform. */
function PlatformAccounts({ links }: { links: PlatformLink[] }) {
  const verified = links.filter((l) => l.status === "verified");
  const [open, setOpen] = useState<string | null>(
    verified.length === 1 ? verified[0]!.name : null,
  );
  return (
    <ul className="ops-todo" aria-label="平台账号">
      {links.map((l) => (
        <li
          key={l.name}
          className={l.status === "conflict" ? "critical" : "normal"}
        >
          <div>
            <b>
              {l.name}
              {l.disabled && <span className="ops-muted small"> · 已停用</span>}
            </b>
            <small>
              {l.status === "unbound" ? "未绑定" : platformStatusText[l.status]}
              {l.uid ? ` · UID ${l.uid}` : ""}
            </small>
            {open === l.name && l.status !== "unbound" && (
              <small>
                绑定时间 {l.boundAt ?? "—"} · 最近业务日期 {l.lastDay ?? "—"} ·
                Platform 业务摘要待接入
              </small>
            )}
          </div>
          <strong />
          {l.status !== "unbound" && (
            <button onClick={() => setOpen(open === l.name ? null : l.name)}>
              {open === l.name ? "收起" : "详情"}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
