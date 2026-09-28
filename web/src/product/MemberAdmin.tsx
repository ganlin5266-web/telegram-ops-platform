import { useEffect, useState, useRef } from "react";
import { request, json } from "../api";
export function MemberAdmin({
  brandId,
  csrf,
}: {
  brandId: string;
  csrf: string;
}) {
  const pendingAdjustment = useRef<{
    delta: string;
    reason: string;
    key: string;
  } | null>(null);
  const base = `/v1/brands/${brandId}/members`;
  const [options, setOptions] = useState<any>({ platforms: [], batches: [] });
  const [thresholds, setThresholds] = useState([0, 500, 2000, 6000, 15000]);
  const [tiers, setTiers] = useState(["20", "50", "100", "300", "500", "1000"]);
  const [status, setStatus] = useState<any>(),
    [tab, setTab] = useState("users"),
    [items, setItems] = useState<any[]>([]),
    [detail, setDetail] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<any>(),
    [form, setForm] = useState({
      kind: "growth",
      from: "",
      until: "",
      timezone: "America/Sao_Paulo",
      platformId: "",
      batchId: "",
    }),
    [delta, setDelta] = useState(""),
    [reason, setReason] = useState(""),
    [next, setNext] = useState<string | null>(null);
  useEffect(() => {
    if (tab === "rules")
      request<any>(base + "/rule-options")
        .then(setOptions)
        .catch(() => {});
  }, [brandId, tab]);
  async function load(after?: string) {
    setError("");
    try {
      const s = await request<any>(base + "/status");
      setStatus(s);
      if (!s.schemaReady) return;
      const data = await request<any>(
        base +
          (tab === "users" ? `?${after ? "after=" + after : ""}` : "/rules"),
      );
      setItems(after ? [...items, ...data.items] : data.items);
      setNext(data.next ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    setItems([]);
    setDetail(undefined);
    setPreview(undefined);
    void load();
  }, [brandId, tab]);
  function input() {
    return {
      kind: form.kind,
      platformId: form.kind === "platform" ? form.platformId : null,
      effectiveFrom: form.from,
      effectiveUntil: form.until,
      config:
        form.kind === "level"
          ? {
              levels: thresholds.map((threshold, i) => ({
                key: `level_${i + 1}`,
                name: ["Starter", "Active", "Gold", "Elite", "Legend"][i],
                threshold,
              })),
              grandfather: true,
            }
          : form.kind === "growth"
            ? {
                timezone: form.timezone,
                cap: 350,
                priority: [
                  "platform_daily",
                  "qualified_referral",
                  "member_task",
                  "daily_checkin",
                ],
                checkin: 5,
                taskCap: 50,
                referral: 50,
                referralCap: 250,
              }
            : {
                currency: "BRL",
                timezone: form.timezone,
                metric: "deposit_amount",
                mappingBatchId: form.batchId,
                tiers: tiers.map((n, i) => ({
                  threshold: String(n),
                  growth: [10, 20, 40, 70, 100, 150][i],
                })),
              },
    };
  }
  async function act(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>会员与成长值</h2>
      <p>STAGING / TEST ONLY</p>
      {error && <p role="alert">{error}</p>}
      {!status ? (
        <p>正在读取</p>
      ) : !status.schemaReady ? (
        <p>会员数据库尚未安装，等待 Migration 审批。</p>
      ) : (
        <>
          <p>
            {status.enabled
              ? "成长值已启用"
              : "成长值未启用；仅可准备规则和查看历史。"}
          </p>
          <nav aria-label="会员管理">
            <button onClick={() => setTab("users")}>会员用户</button>
            <button onClick={() => setTab("rules")}>等级设置 / 成长规则</button>
          </nav>
          <button disabled={busy} onClick={() => void load()}>
            刷新
          </button>
          {tab === "users" ? (
            <>
              <p>同一品牌共享会员等级和成长值，积分保持原账户。</p>
              {!items.length && <p>暂无初始化会员</p>}
              {items.map((m) => (
                <button
                  key={m.id}
                  onClick={() =>
                    void act(async () =>
                      setDetail(await request(base + "/" + m.id)),
                    )
                  }
                >
                  会员 {m.id.slice(0, 8)} · LV{m.level} · {m.growth} Growth
                </button>
              ))}
              {next && (
                <button onClick={() => void load(next)}>加载更多</button>
              )}
              {detail && (
                <section>
                  <h3>
                    LV{detail.level} · {detail.growth} Growth
                  </h3>
                  <h4>成长记录</h4>
                  {detail.ledger.map((l: any) => (
                    <p key={l.id}>
                      {l.business_date} · {l.delta} · {l.reason_code}
                    </p>
                  ))}
                  <h4>等级历史</h4>
                  {detail.history.map((h: any, i: number) => (
                    <p key={i}>
                      LV{h.previous_level ?? 1} → LV{h.new_level} ·{" "}
                      {h.reason_code === "level_protected_v1"
                        ? "等级保护"
                        : h.created_at}
                    </p>
                  ))}
                  <details>
                    <summary>每日分配详情</summary>
                    {detail.reconciliations.map((r: any) => (
                      <div key={r.id}>
                        <b>
                          {r.business_date}：{r.total}
                        </b>
                        {r.allocation.map((a: any) => (
                          <p key={a.id}>
                            {a.kind}：实际 {a.granted} / 理论 {a.requested}
                            {a.capApplied ? "（达到上限）" : ""}
                          </p>
                        ))}
                      </div>
                    ))}
                  </details>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(async () => {
                        if (
                          pendingAdjustment.current &&
                          (pendingAdjustment.current.delta !== delta ||
                            pendingAdjustment.current.reason !== reason)
                        )
                          throw Error(
                            "上一笔调整结果尚未确认，请保持原值重试核对。",
                          );
                        const b = pendingAdjustment.current ?? {
                          delta,
                          reason,
                          key: crypto.randomUUID(),
                        };
                        pendingAdjustment.current = b;
                        const p = await request<any>(
                          base + "/" + detail.id + "/adjustment-preview",
                          json(b, csrf),
                        );
                        if (
                          p.requiresConfirmation &&
                          !window.confirm(
                            `确认调整 ${delta} Growth？该操作保留永久记录。`,
                          )
                        ) {
                          pendingAdjustment.current = null;
                          return;
                        }
                        await request(
                          base + "/" + detail.id + "/adjustments",
                          json({ ...b, confirmation: p.confirmation }, csrf),
                        );
                        pendingAdjustment.current = null;
                        setDelta("");
                        setReason("");
                        setDetail(await request(base + "/" + detail.id));
                      });
                    }}
                  >
                    <label>
                      调整整数成长值
                      <input
                        value={delta}
                        onChange={(e) => setDelta(e.target.value)}
                        required
                      />
                    </label>
                    <label>
                      原因
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        required
                        maxLength={100}
                      />
                    </label>
                    <button disabled={busy || !status.enabled}>
                      审核并调整
                    </button>
                  </form>
                </section>
              )}
            </>
          ) : (
            <>
              <p>
                发布不可修改；新版本必须使用不重叠的生效日期。正式数值需另行批准。
              </p>
              {items.map((v) => (
                <section className="card" key={v.id}>
                  <h3>
                    {v.kind === "level"
                      ? "等级规则"
                      : v.kind === "growth"
                        ? "每日成长规则"
                        : "平台成长规则"}{" "}
                    · V{v.version}
                  </h3>
                  <p>
                    {v.status === "published" ? "已发布" : "草稿"} ·{" "}
                    {v.effective_from} — {v.effective_until}
                  </p>
                  {v.kind === "level" &&
                    v.config.levels.map((l: any) => (
                      <p key={l.key}>
                        {l.name} ≥ {l.threshold}
                      </p>
                    ))}
                  {v.kind === "platform" &&
                    v.config.tiers.map((t: any) => (
                      <p key={t.threshold}>
                        {t.threshold} BRL → {t.growth} Growth
                      </p>
                    ))}
                  {v.status === "draft" && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm("确认发布此测试规则版本？"))
                          void act(async () => {
                            await request(
                              base + "/rules/" + v.id + "/publish",
                              json({}, csrf),
                            );
                            await load();
                          });
                      }}
                    >
                      发布版本
                    </button>
                  )}
                </section>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () =>
                    setPreview(
                      await request(
                        base + "/rules/preview",
                        json(input(), csrf),
                      ),
                    ),
                  );
                }}
              >
                <h3>准备测试规则</h3>
                <label>
                  类型
                  <select
                    value={form.kind}
                    onChange={(e) => {
                      setForm({ ...form, kind: e.target.value });
                      setPreview(undefined);
                    }}
                  >
                    <option value="growth">每日成长规则</option>
                    <option value="level">等级规则</option>
                    <option value="platform">平台成长规则</option>
                  </select>
                </label>
                {[
                  ["from", "生效日期"],
                  ["until", "截止日期"],
                  ["timezone", "会员/平台业务时区"],
                ].map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      required
                      type={key === "from" || key === "until" ? "date" : "text"}
                      value={(form as any)[key!]}
                      onChange={(e) => {
                        setForm({ ...form, [key!]: e.target.value });
                        setPreview(undefined);
                      }}
                    />
                  </label>
                ))}
                {form.kind === "level" &&
                  thresholds.map((v, i) => (
                    <label key={i}>
                      LV{i + 1} 门槛
                      <input
                        type="number"
                        min="0"
                        step="1"
                        disabled={i === 0}
                        value={v}
                        onChange={(e) => {
                          setThresholds(
                            thresholds.map((n, j) =>
                              j === i ? Number(e.target.value) : n,
                            ),
                          );
                          setPreview(undefined);
                        }}
                      />
                    </label>
                  ))}
                {form.kind === "platform" && (
                  <>
                    <label>
                      平台
                      <select
                        required
                        value={form.platformId}
                        onChange={(e) => {
                          const p = options.platforms?.find(
                            (p: any) => p.id === e.target.value,
                          );
                          setForm({
                            ...form,
                            platformId: e.target.value,
                            batchId: "",
                            timezone: p?.timezone ?? form.timezone,
                          });
                          setPreview(undefined);
                        }}
                      >
                        <option value="">选择测试平台</option>
                        {options.platforms
                          ?.filter((p: any) => p.currency === "BRL")
                          .map((p: any) => (
                            <option key={p.id} value={p.id}>
                              {p.display_name} · {p.currency}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      数据映射批次
                      <select
                        required
                        value={form.batchId}
                        onChange={(e) => {
                          setForm({ ...form, batchId: e.target.value });
                          setPreview(undefined);
                        }}
                      >
                        <option value="">选择已审核映射</option>
                        {options.batches
                          ?.filter(
                            (b: any) =>
                              b.platform_id === form.platformId && b.adapter,
                          )
                          .map((b: any) => (
                            <option key={b.id} value={b.id}>
                              {b.business_date} · {b.adapter} / {b.version} ·{" "}
                              {b.id.slice(0, 8)}
                            </option>
                          ))}
                      </select>
                    </label>
                    {tiers.map((v, i) => (
                      <label key={i}>
                        充值门槛（BRL） → {[10, 20, 40, 70, 100, 150][i]} Growth
                        <input
                          type="number"
                          min="0"
                          step="0.000001"
                          value={v}
                          onChange={(e) => {
                            setTiers(
                              tiers.map((n, j) =>
                                j === i ? e.target.value : n,
                              ),
                            );
                            setPreview(undefined);
                          }}
                        />
                      </label>
                    ))}
                  </>
                )}
                <button disabled={busy}>预览</button>
              </form>
              {preview && (
                <section>
                  <h4>预览通过 · 尚未保存</h4>
                  <p>固定 Staging 测试配置；此步骤没有写入业务数据。</p>
                  {preview.examples.map((e: any, i: number) => (
                    <p key={i}>
                      {e.value ?? e.name} → {e.growth ?? e.threshold}
                    </p>
                  ))}
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await request(base + "/rules", json(input(), csrf));
                        setPreview(undefined);
                        await load();
                      })
                    }
                  >
                    保存草稿
                  </button>
                </section>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
