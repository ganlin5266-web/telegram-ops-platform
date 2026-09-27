import { useEffect, useState } from "react";
import { ApiError, json, request } from "../api";
type Props = {
  base: string;
  permissions: string[];
  csrf: string;
  onExpire: () => void;
};
const stateLabels: Record<string, string> = {
  pending: "待数据/规则",
  eligible: "符合资格",
  ineligible: "未达到门槛",
  review_required: "待复核",
  draft: "草稿",
  published: "已发布",
  retired: "已停用",
};
export default function Entitlements({
  base,
  permissions,
  csrf,
  onExpire,
}: Props) {
  const root = base + "/entitlements";
  const [tab, setTab] = useState("rules"),
    [rules, setRules] = useState<any[]>([]),
    [platforms, setPlatforms] = useState<any[]>([]),
    [batches, setBatches] = useState<any[]>([]),
    [rows, setRows] = useState<any[]>([]),
    [detail, setDetail] = useState<any>(null),
    [conflictDetail, setConflictDetail] = useState<any>(null);
  const [enabled, setEnabled] = useState(false),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<any>(null);
  const [platformId, setPlatformId] = useState(""),
    [date, setDate] = useState(""),
    [reason, setReason] = useState(""),
    [showDraft, setShowDraft] = useState(false);
  const [form, setForm] = useState({
    name: "",
    mappingBatchId: "",
    sourceTimezone: "",
    entitlementTimezone: "",
    currency: "",
    cutoffTime: "12:00",
    effectiveFrom: "",
    effectiveUntil: "",
    value: "100",
  });
  const [tiers, setTiers] = useState([
    { key: "tier_1", name: "Tier 1", threshold: "100.00" },
    { key: "tier_2", name: "Tier 2", threshold: "500.00" },
    { key: "tier_3", name: "Tier 3", threshold: "1000.00" },
  ]);
  const canManage = permissions.includes("entitlements.rules.manage"),
    canRun = permissions.includes("entitlements.recalculate");
  const api = async (path: string, body?: unknown) =>
    request<any>(root + path, body === undefined ? {} : json(body, csrf));
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onExpire();
      else setError(e instanceof ApiError ? e.message : "操作失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setConflictDetail(null);
    if (!permissions.includes("entitlements.read")) return;
    let live = true;
    Promise.all([
      request<any>(root + "/rules"),
      request<any>(root + "/platforms"),
    ])
      .then(([r, p]) => {
        if (live) {
          setRules(r.items);
          setReady(r.schemaReady);
          setEnabled(r.enabled);
          setPlatforms(p.items ?? p.platforms ?? []);
        }
      })
      .catch((e) => {
        if (live) {
          if (e instanceof ApiError && e.status === 401) onExpire();
          else setError("会员权益读取失败");
        }
      });
    return () => {
      live = false;
    };
  }, [base]);
  const rule = () => ({
    platformId,
    name: form.name,
    metric: "deposit_amount",
    operator: ">=",
    currency: form.currency,
    sourceTimezone: form.sourceTimezone,
    entitlementTimezone: form.entitlementTimezone,
    cutoffTime: form.cutoffTime,
    effectiveFrom: form.effectiveFrom,
    effectiveUntil: form.effectiveUntil,
    mappingBatchId: form.mappingBatchId,
    tiers,
  });
  async function refresh() {
    if (tab === "rules") {
      const r = await api("/rules");
      setRules(r.items);
      setEnabled(r.enabled);
      setReady(r.schemaReady);
      return;
    }
    if (tab === "tasks") {
      setRows((await api("/tasks")).items);
      return;
    }
    if (!platformId || !date) {
      setError("请选择平台和权益日期");
      return;
    }
    const q = `?platformId=${encodeURIComponent(platformId)}&date=${encodeURIComponent(date)}`;
    setRows(
      (
        await api(
          (tab === "sla" ? "/sla" : "/daily") +
            q +
            (tab === "pending"
              ? "&status=pending"
              : tab === "review"
                ? "&status=review_required"
                : ""),
        )
      ).items,
    );
  }
  if (!permissions.includes("entitlements.read"))
    return <p>你没有查看会员权益的权限。</p>;
  return (
    <section className="panel">
      <h2>会员权益</h2>
      <p>
        仅计算 D 日事实对应的 D+1
        资格，不发积分或游戏次数。详细状态仅管理员可见。
      </p>
      <p role="status">
        {!ready
          ? "Schema 尚未就绪"
          : enabled
            ? "资格计算已启用"
            : "资格计算关闭；草稿与预览可用"}
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="toolbar">
        {[
          ["rules", "权益规则"],
          ["daily", "日资格"],
          ["pending", "待处理"],
          ["review", "待复核"],
          ["sla", "数据 SLA"],
          ["tasks", "计算记录"],
        ].map(([id, label]) => (
          <button
            key={id}
            onClick={() => {
              setTab(id!);
              setRows([]);
              setDetail(null);
              setConflictDetail(null);
            }}
            aria-pressed={tab === id}
          >
            {label}
          </button>
        ))}
      </div>
      <label>
        平台
        <select
          aria-label="权益平台"
          value={platformId}
          onChange={(e) => {
            const id = e.target.value;
            setPlatformId(id);
            setRows([]);
            setDetail(null);
            setConflictDetail(null);
            const p = platforms.find((p) => p.id === id);
            if (p)
              setForm((v) => ({
                ...v,
                currency: p.currency,
                sourceTimezone: p.timezone,
                entitlementTimezone: p.timezone,
              }));
            if (id && canManage)
              void act(async () =>
                setBatches(
                  (
                    await request<any>(
                      root + "/mapping-batches?platformId=" + id,
                    )
                  ).items,
                ),
              );
          }}
        >
          <option value="">选择平台</option>
          {platforms.map((p) => (
            <option key={p.id} value={p.id}>
              {p.display_name}
            </option>
          ))}
        </select>
      </label>
      {tab !== "rules" && (
        <label>
          权益日期
          <input
            aria-label="权益日期"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      )}
      <button disabled={busy} onClick={() => void act(refresh)}>
        刷新
      </button>
      {tab === "rules" ? (
        <>
          {canManage && (
            <button disabled={!ready} onClick={() => setShowDraft(!showDraft)}>
              新建规则版本
            </button>
          )}
          {showDraft && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await api("/rules", rule());
                  setShowDraft(false);
                  await refresh();
                });
              }}
            >
              <h3>创建草稿</h3>
              <p>
                Staging 规则名称必须清楚标记 STAGING TEST
                ONLY。正式门槛尚未批准。
              </p>
              {(
                [
                  ["name", "规则名称"],
                  ["currency", "币种"],
                  ["sourceTimezone", "平台业务时区"],
                  ["entitlementTimezone", "权益时区"],
                  ["cutoffTime", "数据 SLA 截止时间"],
                  ["effectiveFrom", "生效权益日期"],
                  ["effectiveUntil", "结束权益日期"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    required
                    aria-label={label}
                    type={
                      key === "effectiveFrom" || key === "effectiveUntil"
                        ? "date"
                        : key === "cutoffTime"
                          ? "time"
                          : "text"
                    }
                    value={form[key]}
                    onChange={(e) =>
                      setForm({ ...form, [key]: e.target.value })
                    }
                  />
                </label>
              ))}
              <label>
                批准的 Mapping 来源批次
                <select
                  required
                  aria-label="Mapping来源批次"
                  value={form.mappingBatchId}
                  onChange={(e) =>
                    setForm({ ...form, mappingBatchId: e.target.value })
                  }
                >
                  <option value="">选择已复核的充值字段来源</option>
                  {batches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.business_date} / {b.original_filename} / {b.status}
                    </option>
                  ))}
                </select>
              </label>
              <p>指标：D 日充值金额 · 比较：≥ · 只匹配最高档，不累加</p>
              {tiers.map((t, i) => (
                <fieldset key={t.key}>
                  <legend>{t.key}</legend>
                  <label>
                    显示名称
                    <input
                      value={t.name}
                      onChange={(e) =>
                        setTiers(
                          tiers.map((v, j) =>
                            j === i ? { ...v, name: e.target.value } : v,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    门槛金额
                    <input
                      required
                      inputMode="decimal"
                      value={t.threshold}
                      onChange={(e) =>
                        setTiers(
                          tiers.map((v, j) =>
                            j === i ? { ...v, threshold: e.target.value } : v,
                          ),
                        )
                      }
                    />
                  </label>
                </fieldset>
              ))}
              <label>
                预览合成金额
                <input
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                />
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () =>
                    setPreview(
                      await api("/rules/preview", {
                        rule: rule(),
                        value: form.value,
                      }),
                    ),
                  )
                }
              >
                预览，不写资格
              </button>
              {preview && (
                <p>
                  {stateLabels[preview.status]} {preview.matchedTier ?? "—"} /{" "}
                  {preview.reasonCode}
                </p>
              )}
              <button disabled={busy || !platformId}>保存草稿</button>
            </form>
          )}
          {rules.map((r) => (
            <article key={r.version_id}>
              <h3>
                {r.name} · V{r.version}
              </h3>
              <p>
                {stateLabels[r.status]} / {r.currency} / {r.metric} /{" "}
                {r.effective_from}—{r.effective_until}
              </p>
              <p>
                来源 {r.source_timezone} · 权益 {r.entitlement_timezone} · SLA{" "}
                {r.cutoff_time}
              </p>
              <ul>
                {r.tiers.map((t: any) => (
                  <li key={t.key}>
                    {t.key} / {t.name} ≥ {t.threshold}
                  </li>
                ))}
              </ul>
              {canManage && r.status === "draft" && (
                <button
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "确认已审核该版本、日期、时区和 Mapping？发布后不可修改。",
                      )
                    )
                      void act(async () => {
                        await api("/rules/" + r.version_id + "/publish", {
                          confirm: true,
                        });
                        await refresh();
                      });
                  }}
                >
                  发布版本
                </button>
              )}
              {canManage && r.status === "published" && (
                <button
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("停止该版本未来适用，保留历史？"))
                      void act(async () => {
                        await api("/rules/" + r.version_id + "/retire", {
                          confirm: true,
                        });
                        await refresh();
                      });
                  }}
                >
                  停用版本
                </button>
              )}
            </article>
          ))}
        </>
      ) : (
        <>
          {canRun && enabled && (
            <div>
              <label>
                重算原因代码
                <input
                  value={reason}
                  placeholder="data_review"
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <button
                disabled={busy || !date || !platformId || !reason}
                onClick={() =>
                  void act(async () => {
                    await api("/recalculate", { platformId, date, reason });
                    await refresh();
                  })
                }
              >
                排队当前平台/日期
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api("/tasks/run", { limit: 20 });
                    await refresh();
                  })
                }
              >
                执行最多20个到期任务
              </button>
            </div>
          )}
          <table>
            <thead>
              <tr>
                <th>状态</th>
                <th>用户 / 日期</th>
                <th>档位 / 原因</th>
                <th>证据</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id ?? i}>
                  <td>{stateLabels[r.status] ?? r.status}</td>
                  <td>
                    {r.uidMasked ?? r.user_id ?? r.users} {r.entitlement_date}
                  </td>
                  <td>
                    {r.matched_tier ?? "—"} /{" "}
                    {r.reason_code === "conflicting_data"
                      ? "平台数据存在冲突"
                      : (r.reason_code ??
                        r.last_error_code ??
                        r.trigger_reason)}
                  </td>
                  <td>
                    {tab !== "tasks" && tab !== "sla" && (
                      <button
                        onClick={() =>
                          void act(async () =>
                            setDetail(await api("/daily/" + r.id)),
                          )
                        }
                      >
                        {r.reason_code === "conflicting_data"
                          ? "查看详情"
                          : "查看计算历史"}
                      </button>
                    )}
                    {r.sla_open ?? r.outcome}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p>当前查询暂无记录；未查询不代表数据为 0。</p>}
          {conflictDetail && (
            <section aria-label="P4 冲突证据">
              <h3>P4 冲突证据</h3>
              <p>
                批次 {conflictDetail.batch.id} ·{" "}
                {conflictDetail.batch.business_date} ·{" "}
                {stateLabels[conflictDetail.batch.status] ??
                  conflictDetail.batch.status}
              </p>
              <p>
                账户 {conflictDetail.row?.uidMasked} · 行{" "}
                {conflictDetail.row?.rowNumber}
              </p>
              <p>系统识别：平台数据修订需要核对</p>
              <button onClick={() => setConflictDetail(null)}>关闭证据</button>
            </section>
          )}
          {detail && (
            <section>
              <h3>资格解释与历史</h3>
              <p>权益日期 {detail.subject.entitlement_date}</p>
              {detail.revisions.map((r: any) => (
                <article key={r.id}>
                  <h4>
                    Revision {r.revision_number}{" "}
                    {r.id === detail.subject.current_revision_id ? "当前" : ""}
                  </h4>
                  <p>
                    {stateLabels[r.status]} / {r.matched_tier ?? "—"} /{" "}
                    {r.reason_code === "conflicting_data"
                      ? "平台数据存在冲突"
                      : r.reason_code}
                  </p>
                  <p>
                    来源日 {r.source_business_date} · 触发 {r.trigger_reason}
                  </p>
                  {"source_value" in r && (
                    <p>
                      Canonical 充值：{r.source_value ?? "未提供"}{" "}
                      {r.result_snapshot?.currency}
                    </p>
                  )}
                  {(r.conflict_evidence ?? []).map((e: any) => (
                    <div key={e.evidence_id}>
                      <p>
                        P4 冲突批次：{e.batch_id} · 行证据：{e.evidence_id}
                      </p>
                      {permissions.includes("platform_data.read") && (
                        <button
                          onClick={() =>
                            void act(async () => {
                              const data = await request<any>(
                                base + "/platform-data/batches/" + e.batch_id,
                              );
                              setConflictDetail({
                                batch: data.batch,
                                row: data.rows.find(
                                  (row: any) => row.id === e.evidence_id,
                                ),
                              });
                            })
                          }
                        >
                          查看 P4 冲突证据
                        </button>
                      )}
                    </div>
                  ))}
                  <dl>
                    {[
                      ["规则版本", r.rule_version_id],
                      ["Identity", r.platform_identity_id],
                      ["Fact Revision", r.daily_fact_revision_id],
                      ["Import Batch", r.batch_id],
                      [
                        "Mapping",
                        `${r.adapter_id ?? "—"} / ${r.mapping_version ?? "—"}`,
                      ],
                      ["Source Evidence", r.evidence_id],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value ?? "未提供"}</dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </section>
  );
}
