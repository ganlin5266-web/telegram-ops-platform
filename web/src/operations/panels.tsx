import { useState } from "react";
import {
  date,
  DateFields,
  datesQuery,
  parameters,
  Pager,
  Status,
  useDebounced,
  usePages,
  useRemote,
  type Fields,
  type Page,
} from "./query";
type Person = {
  id: string;
  telegramUserId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};
type Referral = {
  id: string;
  boundAt: string;
  status: string;
  rewardStatus: string;
  inviter: Person;
  invitee: Person;
};
type Referrals = Page<Referral> & {
  invitedBy: Omit<Referral, "invitee"> | null;
  invitedCount: string;
};
const PersonView = ({ person }: { person: Person }) => (
  <>
    <strong>
      {[person.firstName, person.lastName].filter(Boolean).join(" ") ||
        "未提供姓名"}
    </strong>
    <small>
      Telegram ID：{person.telegramUserId} ·{" "}
      {person.username ? `@${person.username}` : "无 Username"}
    </small>
  </>
);
export function ReferralPanel({
  base,
  userId,
  onExpire,
}: {
  base: string;
  userId?: string;
  onExpire: () => void;
}) {
  const [fields, setFields] = useState<Fields>({});
  const query = parameters(datesQuery(fields)),
    settled = useDebounced(query),
    waiting = query !== settled;
  const page = usePages<Referral, Referrals>(
    userId ? `${base}/users/${userId}/referrals` : `${base}/referrals`,
    settled,
    onExpire,
    !waiting,
  );
  const change = (key: string, value: string) =>
    setFields((f) => ({ ...f, [key]: value }));
  return (
    <div className="query-panel">
      <h3>{userId ? "邀请档案" : "当前 Bot 邀请关系"}</h3>
      <p className="language-note">
        当前仅展示系统已有邀请关系和奖励状态；有效邀请资格规则尚未启用。
      </p>
      <div className="filter-grid compact">
        <label>
          邀请状态
          <select
            aria-label="邀请状态"
            value={fields.status || ""}
            onChange={(e) => change("status", e.target.value)}
          >
            <option value="">全部</option>
            <option value="bound">已绑定（bound）</option>
            <option value="qualified">qualified（事实状态）</option>
            <option value="invalid">invalid（事实状态）</option>
          </select>
        </label>
        <label>
          奖励状态
          <select
            value={fields.rewardStatus || ""}
            onChange={(e) => change("rewardStatus", e.target.value)}
          >
            <option value="">全部</option>
            <option value="pending">待处理</option>
            <option value="rewarded">已奖励</option>
            <option value="ineligible">不符合奖励状态</option>
          </select>
        </label>
        {!userId && (
          <label>
            邀请人搜索
            <input
              value={fields.inviter || ""}
              onChange={(e) => change("inviter", e.target.value)}
              placeholder="ID 精确 / 名称前缀"
              maxLength={100}
            />
          </label>
        )}
        <label>
          被邀请人搜索
          <input
            value={fields.invitee || ""}
            onChange={(e) => change("invitee", e.target.value)}
            placeholder="ID 精确 / 名称前缀"
            maxLength={100}
          />
        </label>
        <DateFields fields={fields} onChange={change} prefix="绑定" />
        <button onClick={() => setFields({})}>重置邀请筛选</button>
      </div>
      <Status
        loading={waiting || page.loading}
        error={page.error}
        retry={page.reload}
      />
      {!waiting && page.data && (
        <>
          {userId && (
            <section className="inviter-card">
              <h4>谁邀请了他</h4>
              {page.data.invitedBy ? (
                <>
                  <PersonView person={page.data.invitedBy.inviter} />
                  <p>
                    {date(page.data.invitedBy.boundAt)} ·{" "}
                    {page.data.invitedBy.status} ·{" "}
                    {page.data.invitedBy.rewardStatus}
                  </p>
                </>
              ) : (
                <p>该用户暂无邀请人</p>
              )}
              <h4>他邀请了谁</h4>
              <p>
                邀请人数：{page.data.invitedCount}{" "}
                <small>全部首次绑定关系，不随列表筛选变化</small>
              </p>
            </section>
          )}
          {!page.data.items.length ? (
            <div className="empty">
              {userId ? "该用户暂未邀请其他用户" : "当前条件暂无邀请关系"}
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {["邀请人", "被邀请人", "首次绑定", "状态", "奖励状态"].map(
                      (x) => (
                        <th key={x}>{x}</th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {page.data.items.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <PersonView person={r.inviter} />
                      </td>
                      <td>
                        <PersonView person={r.invitee} />
                      </td>
                      <td>{date(r.boundAt)}</td>
                      <td>{r.status}</td>
                      <td>{r.rewardStatus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <Pager
        page={{
          ...page,
          loading: waiting || page.loading,
          data: waiting ? undefined : page.data,
        }}
      />
    </div>
  );
}
type Ledger = {
  id: string;
  created_at: string;
  direction: string;
  delta: string;
  balance_before: string;
  balance_after: string;
  source: string;
  business_type: string;
  business_id: string;
  note: string;
};
export function LedgerPanel({
  base,
  userId,
  onExpire,
  revision,
}: {
  base: string;
  userId: string;
  onExpire: () => void;
  revision: number;
}) {
  const [fields, setFields] = useState<Fields>({});
  const query = parameters(datesQuery(fields)),
    settled = useDebounced(query),
    waiting = query !== settled;
  const page = usePages<Ledger>(
    `${base}/users/${userId}/point-ledger`,
    settled,
    onExpire,
    !waiting,
    revision,
  );
  const change = (key: string, value: string) =>
    setFields((f) => ({ ...f, [key]: value }));
  return (
    <section className="query-panel">
      <h3>积分流水</h3>
      <div className="filter-grid compact">
        <label>
          积分方向
          <select
            value={fields.direction || ""}
            onChange={(e) => change("direction", e.target.value)}
          >
            <option value="">全部</option>
            <option value="credit">增加</option>
            <option value="debit">扣除</option>
          </select>
        </label>
        <label>
          来源
          <input
            maxLength={100}
            value={fields.source || ""}
            placeholder="例如 admin（精确匹配）"
            onChange={(e) => change("source", e.target.value)}
          />
        </label>
        <label>
          业务类型
          <input
            maxLength={100}
            value={fields.businessType || ""}
            placeholder="例如 manual_adjustment"
            onChange={(e) => change("businessType", e.target.value)}
          />
        </label>
        <DateFields fields={fields} onChange={change} prefix="流水" />
        <button onClick={() => setFields({})}>重置流水筛选</button>
      </div>
      <Status
        loading={waiting || page.loading}
        error={page.error}
        empty={!page.data?.items.length}
        emptyText="暂无积分流水"
        retry={page.reload}
      />
      {!waiting && page.data && !!page.data.items.length && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {[
                  "时间",
                  "方向 / 变化",
                  "变化前 → 变化后",
                  "来源",
                  "业务类型 / ID",
                  "备注",
                ].map((x) => (
                  <th key={x}>{x}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.data.items.map((r) => (
                <tr key={r.id}>
                  <td>{date(r.created_at)}</td>
                  <td className={r.direction === "credit" ? "credit" : "debit"}>
                    {r.direction === "credit" ? "增加" : "扣除"}
                    <strong>
                      {r.direction === "credit" && !r.delta.startsWith("-")
                        ? "+" + r.delta
                        : r.delta}
                    </strong>
                  </td>
                  <td>
                    {r.balance_before} → {r.balance_after}
                  </td>
                  <td>{r.source}</td>
                  <td>
                    {r.business_type}
                    <small>{r.business_id}</small>
                  </td>
                  <td className="note-cell">{r.note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        page={{
          ...page,
          loading: waiting || page.loading,
          data: waiting ? undefined : page.data,
        }}
      />
    </section>
  );
}
type Audit = {
  id: string;
  created_at: string;
  admin_name: string | null;
  admin_id: string | null;
  action: string;
  object_type: string;
  object_id: string | null;
  summary: string;
  result: string;
};
export function AuditPanel({
  base,
  onExpire,
}: {
  base: string;
  onExpire: () => void;
}) {
  const [fields, setFields] = useState<Fields>({});
  const query = parameters(datesQuery(fields)),
    settled = useDebounced(query),
    waiting = query !== settled;
  const page = usePages<Audit>(
    `${base}/audit-logs`,
    settled,
    onExpire,
    !waiting,
  );
  const change = (key: string, value: string) =>
    setFields((f) => ({ ...f, [key]: value }));
  return (
    <section className="query-panel">
      <h3>当前 Bot 操作日志</h3>
      <p className="language-note">
        此处展示当前品牌 / Bot 范围的日志，不能视为当前用户专属操作记录。用户级
        Audit 筛选尚未提供。
      </p>
      <div className="filter-grid compact">
        <label>
          操作类型
          <input
            value={fields.action || ""}
            maxLength={100}
            onChange={(e) => change("action", e.target.value)}
            placeholder="例如 points.adjust"
          />
        </label>
        <DateFields fields={fields} onChange={change} prefix="日志" />
        <button onClick={() => setFields({})}>重置日志筛选</button>
      </div>
      <Status
        loading={waiting || page.loading}
        error={page.error}
        empty={!page.data?.items.length}
        emptyText="暂无操作日志"
        retry={page.reload}
      />
      {!waiting && page.data && !!page.data.items.length && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {["时间", "管理员", "操作", "对象", "摘要", "结果"].map((x) => (
                  <th key={x}>{x}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.data.items.map((r) => (
                <tr key={r.id}>
                  <td>{date(r.created_at)}</td>
                  <td>{r.admin_name || "系统 / 未提供管理员"}</td>
                  <td>{r.action}</td>
                  <td>
                    {r.object_type}
                    <small>{r.object_id || "未公开"}</small>
                  </td>
                  <td className="note-cell">{r.summary}</td>
                  <td>{r.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        page={{
          ...page,
          loading: waiting || page.loading,
          data: waiting ? undefined : page.data,
        }}
      />
    </section>
  );
}
export function UserOverview({
  base,
  userId,
  onExpire,
}: {
  base: string;
  userId: string;
  onExpire: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const profile = useRemote<Record<string, string | null>>(
    `${base}/users/${userId}`,
    revision,
    onExpire,
  );
  const labels: Record<string, string> = {
    id: "内部 User ID",
    telegram_user_id: "Telegram User ID",
    username: "Username",
    first_name: "First Name",
    last_name: "Last Name",
    telegram_language_code: "Telegram Language",
    preferred_language: "Preferred Language",
    resolved_language: "解析语言",
    status: "用户状态",
    first_started_at: "首次启动",
    last_interaction_at: "最后互动",
    created_at: "创建时间",
    updated_at: "更新时间",
  };
  return (
    <section className="query-panel">
      <h3>用户基本资料</h3>
      <Status
        loading={profile.loading}
        error={profile.error?.message}
        retry={() => setRevision((x) => x + 1)}
      />
      {profile.data && (
        <dl className="profile-grid">
          {Object.entries(labels).map(([key, title]) => (
            <div key={key}>
              <dt>{title}</dt>
              <dd>
                {key.endsWith("_at")
                  ? date(profile.data![key] ?? null)
                  : profile.data![key] || "未提供"}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <small>
        解析语言遵循服务端规则；具体模板可能继续回退。后台中文不参与发送语言选择。
      </small>
    </section>
  );
}
export function PointSummary({
  base,
  userId,
  onExpire,
  revision,
}: {
  base: string;
  userId: string;
  onExpire: () => void;
  revision: number;
}) {
  const [retry, setRetry] = useState(0);
  const result = useRemote<{
    balance: string;
    totalEarned: string;
    totalSpent: string;
  }>(`${base}/users/${userId}/points/summary`, revision + retry, onExpire);
  return (
    <section className="summary-section">
      <Status
        loading={result.loading}
        error={result.error?.message}
        retry={() => setRetry((x) => x + 1)}
      />
      {result.data && (
        <div className="point-summary">
          <div>
            <small>累计获得</small>
            <strong>{result.data.totalEarned}</strong>
          </div>
          <div>
            <small>累计消耗</small>
            <strong>{result.data.totalSpent}</strong>
          </div>
        </div>
      )}
      <p className="muted">
        累计获得按所有正积分流水统计，包含退款等正向流水；累计消耗为全部负流水绝对值合计。
      </p>
    </section>
  );
}
