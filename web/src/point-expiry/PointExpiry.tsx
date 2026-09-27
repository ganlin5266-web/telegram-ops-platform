import { useEffect, useRef, useState } from "react";
import { ApiError, json, request } from "../api";
type Version = {
  id: string;
  version: number;
  mode: string;
  rolling_days: number | null;
  deadline: string | null;
  timezone: string;
  effective_at: string;
  status: string;
  refund_min_compensation_days: number | null;
};
type Policy = { id: string; name: string; source: string; versions: Version[] };
type Lot = {
  id: string;
  user_id: string;
  source: string;
  granted_amount: string;
  remaining_amount: string;
  granted_at: string;
  expires_at: string | null;
  timezone?: string;
  status: string;
};
const labels: Record<string, string> = {
  permanent: "永久有效",
  rolling_days: "获得后 N 天",
  fixed_deadline: "统一截止日期",
  available: "可用",
  depleted: "已耗尽",
  expired: "已过期",
  draft: "草稿",
  published: "已发布",
};
const date = (v: string | null, tz = "UTC") =>
  v
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: tz,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(v))
    : "永久有效";
export default function PointExpiry({
  base,
  permissions,
  csrf,
  onExpire,
}: {
  base: string;
  permissions: string[];
  csrf: string;
  onExpire: () => void;
}) {
  const [policies, setPolicies] = useState<Policy[]>([]),
    [lots, setLots] = useState<Lot[]>([]),
    [enabled, setEnabled] = useState(false),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<Record<string, unknown> | null>(null),
    [detail, setDetail] = useState<any>(null),
    [mode, setMode] = useState("permanent"),
    [form, setForm] = useState<Record<string, string>>({
      name: "",
      source: "*",
      timezone: "UTC",
      rollingDays: "30",
      deadlineDate: "",
      refundMinCompensationDays: "",
      effectiveAt: "",
    }),
    [filters, setFilters] = useState({
      userId: "",
      accountId: "",
      source: "",
      status: "",
      from: "",
      to: "",
      expiresBefore: "",
    }),
    [offset, setOffset] = useState(0);
  const alive = useRef(true),
    lock = useRef(false);
  const canRead = permissions.includes("points.expiry.read"),
    canManage = permissions.includes("points.expiry.manage");
  const path = `${base}/point-expiry`;
  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onExpire();
      if (alive.current)
        setError(
          e instanceof ApiError ? e.message : "操作未完成，请检查输入后重试",
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function load() {
    const r = await request<{
      items: Policy[];
      enabled: boolean;
      schemaReady: boolean;
    }>(`${path}/policies`);
    if (!alive.current) return;
    setPolicies(r.items);
    setEnabled(r.enabled);
    setReady(r.schemaReady);
    if (r.schemaReady) await loadLots();
  }
  async function loadLots(next = offset) {
    const q = new URLSearchParams(
      Object.entries(filters)
        .filter(([, v]) => v)
        .map(([k, v]) => [
          k,
          ["from", "to", "expiresBefore"].includes(k)
            ? new Date(v).toISOString()
            : v,
        ]),
    );
    q.set("offset", String(next));
    const r = await request<{ items: Lot[] }>(`${path}/lots?${q}`);
    if (alive.current) {
      setLots(r.items);
      setOffset(next);
    }
  }
  useEffect(() => {
    alive.current = true;
    if (canRead) void run(load);
    return () => {
      alive.current = false;
    };
  }, [base, canRead]);
  function update(k: string, v: string) {
    setForm((x) => ({ ...x, [k]: v }));
    setPreview(null);
  }
  const build = () => ({
    name: form.name,
    source: form.source,
    mode,
    timezone: form.timezone,
    effectiveAt: form.effectiveAt
      ? new Date(form.effectiveAt).toISOString()
      : new Date().toISOString(),
    rollingDays: mode === "rolling_days" ? Number(form.rollingDays) : null,
    ...(mode === "fixed_deadline"
      ? { deadlineDate: form.deadlineDate }
      : { deadline: null }),
    refundMinCompensationDays: form.refundMinCompensationDays
      ? Number(form.refundMinCompensationDays)
      : null,
  });
  const display = (v: Version) =>
    v.mode === "rolling_days"
      ? `获得后 ${v.rolling_days} 天（每天天数按24小时）`
      : v.mode === "fixed_deadline"
        ? `有效至 ${new Intl.DateTimeFormat("zh-CN", { timeZone: v.timezone, dateStyle: "medium" }).format(new Date(Date.parse(v.deadline!) - 1))}（${v.timezone}）`
        : "永久有效";
  if (!canRead)
    return <section className="empty">你没有查看积分有效期的权限。</section>;
  return (
    <section className="panel">
      <h2>积分有效期</h2>
      <p>
        {enabled
          ? "批次积分路径已启用"
          : "批次积分路径未启用；已切换范围暂停写入，未切换范围保持原路径。"}
      </p>
      {!ready && <p>数据库结构尚未就绪。</p>}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy} onClick={() => void run(load)}>
        刷新
      </button>
      {ready && canManage && (
        <details>
          <summary>创建策略版本</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const r = await request<{ policy: Record<string, unknown> }>(
                  `${path}/policies/preview`,
                  json(build(), csrf),
                );
                setPreview(r.policy);
              });
            }}
          >
            <label>
              策略名称
              <input
                required
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
              />
            </label>
            <label>
              积分来源（* 为明确默认策略）
              <input
                required
                value={form.source}
                onChange={(e) => update("source", e.target.value)}
              />
            </label>
            <label>
              有效期模式
              <select
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value);
                  setPreview(null);
                }}
              >
                {Object.entries(labels)
                  .slice(0, 3)
                  .map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
              </select>
            </label>
            {mode === "rolling_days" && (
              <label>
                有效天数
                <input
                  type="number"
                  min="1"
                  max="36500"
                  value={form.rollingDays}
                  onChange={(e) => update("rollingDays", e.target.value)}
                />
              </label>
            )}
            {mode === "fixed_deadline" && (
              <label>
                最后有效日期
                <input
                  required
                  type="date"
                  value={form.deadlineDate}
                  onChange={(e) => update("deadlineDate", e.target.value)}
                />
              </label>
            )}
            <label>
              业务时区
              <input
                required
                value={form.timezone}
                onChange={(e) => update("timezone", e.target.value)}
              />
            </label>
            <details>
              <summary>高级设置</summary>
              <label>
                生效时间（当前设备时区；空白为现在）
                <input
                  type="datetime-local"
                  value={form.effectiveAt}
                  onChange={(e) => update("effectiveAt", e.target.value)}
                />
              </label>
              <label>
                退款最短补偿天数（空白为未配置）
                <input
                  type="number"
                  min="1"
                  value={form.refundMinCompensationDays}
                  onChange={(e) =>
                    update("refundMinCompensationDays", e.target.value)
                  }
                />
              </label>
            </details>
            <button disabled={busy}>预览策略</button>
          </form>
          {preview && (
            <section>
              <h3>发布前预览</h3>
              <p>
                当前所选 Brand / Bot · {String(preview.name)} · 来源{" "}
                {String(preview.source)}
              </p>
              <p>
                {labels[String(preview.mode)]} · {String(preview.timezone)} ·
                生效{" "}
                {date(String(preview.effectiveAt), String(preview.timezone))}
              </p>
              {preview.rollingDays != null && (
                <p>{String(preview.rollingDays)} 天</p>
              )}
              {preview.deadline != null && (
                <p>
                  截止：
                  {date(String(preview.deadline), String(preview.timezone))}
                  （排他）
                </p>
              )}
              <p>旧批次不受新策略影响。保存为草稿后，需要单独确认发布。</p>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await request(`${path}/policies`, json(preview, csrf));
                    setPreview(null);
                    await load();
                  })
                }
              >
                保存草稿
              </button>
            </section>
          )}
        </details>
      )}
      <h3>策略与版本</h3>
      {policies.length === 0 && (
        <p>暂无策略；启用后未匹配策略的新增积分将被拒绝。</p>
      )}
      {policies.map((p) => (
        <article key={p.id}>
          <h4>
            {p.name} · {p.source === "*" ? "默认" : p.source}
          </h4>
          {p.versions.map((v) => (
            <div key={v.id}>
              <p>
                v{v.version} · {labels[v.status]} · {display(v)}
              </p>
              <p>
                生效：{date(v.effective_at, v.timezone)} · 退款补偿：
                {v.refund_min_compensation_days == null
                  ? "未配置"
                  : `${v.refund_min_compensation_days}天`}
              </p>
              {canManage && v.status === "draft" && (
                <button
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `确认发布 ${p.name} v${v.version}？\n${display(v)}\n仅影响新的积分获得。`,
                      )
                    )
                      void run(async () => {
                        await request(
                          `${path}/policies/${v.id}/publish`,
                          json({ confirm: true }, csrf),
                        );
                        await load();
                      });
                  }}
                >
                  确认发布
                </button>
              )}
              {canManage && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setMode(v.mode);
                    setForm({
                      name: p.name,
                      source: p.source,
                      timezone: v.timezone,
                      rollingDays: String(v.rolling_days ?? 30),
                      deadlineDate: "",
                      refundMinCompensationDays:
                        v.refund_min_compensation_days == null
                          ? ""
                          : String(v.refund_min_compensation_days),
                      effectiveAt: "",
                    });
                    setPreview(null);
                  }}
                >
                  复制到新版本表单
                </button>
              )}
            </div>
          ))}
        </article>
      ))}
      {ready && (
        <>
          <h3>积分批次</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => loadLots(0));
            }}
          >
            <label>
              用户内部ID
              <input
                value={filters.userId}
                onChange={(e) =>
                  setFilters({ ...filters, userId: e.target.value })
                }
              />
            </label>
            <label>
              来源
              <input
                value={filters.source}
                onChange={(e) =>
                  setFilters({ ...filters, source: e.target.value })
                }
              />
            </label>
            <label>
              状态
              <select
                value={filters.status}
                onChange={(e) =>
                  setFilters({ ...filters, status: e.target.value })
                }
              >
                <option value="">全部</option>
                {["available", "depleted", "expired"].map((x) => (
                  <option key={x} value={x}>
                    {labels[x]}
                  </option>
                ))}
              </select>
            </label>
            <details>
              <summary>高级筛选</summary>
              <label>
                积分账户内部ID
                <input
                  value={filters.accountId}
                  onChange={(e) =>
                    setFilters({ ...filters, accountId: e.target.value })
                  }
                />
              </label>
              {(
                [
                  ["from", "获得时间起"],
                  ["to", "获得时间止（不含）"],
                  ["expiresBefore", "到期时间上限"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {label}（当前设备时区）
                  <input
                    type="datetime-local"
                    value={filters[key]}
                    onChange={(e) =>
                      setFilters({ ...filters, [key]: e.target.value })
                    }
                  />
                </label>
              ))}
            </details>
            <button disabled={busy}>查询批次</button>
          </form>
          {lots.length === 0 ? (
            <p>暂无积分批次。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>来源</th>
                  <th>获得</th>
                  <th>剩余</th>
                  <th>到期</th>
                  <th>状态</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {lots.map((l) => (
                  <tr key={l.id}>
                    <td>{l.source}</td>
                    <td>{l.granted_amount}</td>
                    <td>{l.remaining_amount}</td>
                    <td>{date(l.expires_at, l.timezone ?? "UTC")}</td>
                    <td>{labels[l.status]}</td>
                    <td>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () =>
                            setDetail(await request(`${path}/lots/${l.id}`)),
                          )
                        }
                      >
                        查看
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button
            disabled={busy || offset === 0}
            onClick={() => void run(() => loadLots(Math.max(0, offset - 50)))}
          >
            上一批次页
          </button>
          <button
            disabled={busy || lots.length < 50}
            onClick={() => void run(() => loadLots(offset + 50))}
          >
            下一批次页
          </button>
        </>
      )}
      {detail && (
        <section>
          <h3>批次解释</h3>
          <button onClick={() => setDetail(null)}>关闭详情</button>
          <p>
            获得 {detail.lot.granted_amount} · 剩余{" "}
            {detail.lot.remaining_amount} · 来源 {detail.lot.source}
          </p>
          <p>
            账面 {detail.summary.balance ?? "—"} · 可用{" "}
            {detail.summary.availableBalance ?? "—"} · 待过期结算{" "}
            {detail.summary.pendingExpiry} · 即将到期{" "}
            {detail.summary.expiringSoon} · 永久{" "}
            {detail.summary.permanentBalance ?? "—"}
          </p>
          <p>
            对账：
            {detail.reconciliation.consistent === true
              ? "一致"
              : detail.reconciliation.consistent === false
                ? "异常，停止积分操作"
                : "尚未启用"}
          </p>
          <p>
            有效期：
            {date(
              detail.lot.expires_at,
              detail.lot.policy_snapshot.timezone ?? "UTC",
            )}
          </p>
          <h4>消费与过期分配</h4>
          {detail.allocations.length === 0 ? (
            <p>暂无扣减。</p>
          ) : (
            detail.allocations.map((a: any) => (
              <p key={a.id}>
                {a.kind === "expire" ? "过期" : "消费"}：{a.amount} ·{" "}
                {date(a.created_at)}
              </p>
            ))
          )}
          <p>关联退款批次：{detail.refunds.length}</p>
          <h4>审计记录</h4>
          {(detail.audit ?? []).map((a: any) => (
            <p key={a.id}>
              {a.action} ·{" "}
              {date(a.created_at, detail.lot.policy_snapshot.timezone ?? "UTC")}{" "}
              · {a.admin_id ? "管理员操作" : "系统操作"}
            </p>
          ))}
          <details>
            <summary>诊断关联ID</summary>
            <p>Lot：{detail.lot.id}</p>
            <p>
              Ledger：{detail.lot.positive_ledger_id ?? "历史期初，无新增流水"}
            </p>
            <p>策略版本：{detail.lot.policy_version_id ?? "历史期初"}</p>
            {detail.allocations.map((a: any) => (
              <p key={a.id}>
                扣分流水：{a.negative_ledger_id} · 分配：{a.id}
              </p>
            ))}
            {detail.refunds.map((r: any) => (
              <p key={r.id}>
                退款批次：{r.id} · 退款流水：{r.positive_ledger_id} · 原分配：
                {r.refund_allocation_id}
              </p>
            ))}
          </details>
        </section>
      )}
    </section>
  );
}
