import { useEffect, useRef, useState } from "react";
import { ApiError, json, request } from "../api";

type Platform = {
  id: string;
  code: string;
  display_name: string;
  currency: string;
  timezone: string;
  status: string;
};
type Rule = {
  id: string;
  platform_id: string;
  tier_key: string;
  version: number;
  status: "draft" | "published" | "disabled";
  name: string;
  points_cost: string;
  face_value: string;
  face_currency: string;
  effective_from: string;
  effective_until: string | null;
  enabled: boolean;
};
type InventoryRow = {
  platform_id: string;
  rule_id: string;
  total: number;
  available: number;
  expired: number;
  disabled: number;
  assigned: number;
  claimed: number;
};
type Batch = {
  id: string;
  platform_id: string;
  rule_id: string;
  status: "imported" | "rejected";
  total_count: number;
  imported_count: number;
  duplicate_count: number;
  created_at: string;
};
type ImportResult = Pick<
  Batch,
  "status" | "total_count" | "imported_count" | "duplicate_count"
>;
type Preview = {
  readonly: true;
  writes: 0;
  rule: {
    platformId: string;
    tierKey: string;
    name: string;
    pointsCost: number;
    faceValue: string;
    currency: string;
    effectiveFrom: string;
    effectiveUntil: string | null;
    mode: "fixed";
    dailyCountLimit: 1;
    dailyPointsLimit: 300;
    requiresDeposit: false;
    timezone: string;
  };
};

const statusText = { draft: "草稿", published: "已发布", disabled: "已停用" };
const batchText = { imported: "已导入", rejected: "已拒绝" };

/** One opaque code per non-empty line. Codes are never logged or rendered. */
export function parseCodeLines(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((code) => code.trim())
    .filter(Boolean);
}

function safeDate(value: string) {
  return value ? new Date(value).toLocaleString("zh-CN") : "—";
}

export default function RedemptionInventory({
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
  const canRead = permissions.includes("redemptions.read");
  const canRules = permissions.includes("redemptions.rules.manage");
  const canInventory = permissions.includes("redemptions.inventory.manage");
  const canPlatforms = permissions.includes("platforms.read");
  const [rules, setRules] = useState<Rule[]>([]);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ruleOpen, setRuleOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [ruleId, setRuleId] = useState("");
  const [codes, setCodes] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const live = useRef(true);
  const lock = useRef(false);

  function fail(value: unknown) {
    if (!live.current) return;
    if (value instanceof ApiError && value.status === 401) return onExpire();
    setError(value instanceof Error ? value.message : "请求失败，请重试");
  }

  async function load() {
    const [ruleData, stockData, batchData, platformData] = await Promise.all([
      request<{ items: Rule[] }>(base + "/redemption-rules"),
      request<{ items: InventoryRow[] }>(base + "/redemption-inventory"),
      request<{ items: Batch[] }>(base + "/redemption-code-batches"),
      canPlatforms
        ? request<{ items: Platform[] }>(base + "/platforms")
        : Promise.resolve({ items: [] as Platform[] }),
    ]);
    if (!live.current) return;
    setRules(ruleData.items);
    setInventory(stockData.items);
    setBatches(batchData.items);
    setPlatforms(platformData.items);
    setRuleId((old) =>
      ruleData.items.some((r) => r.id === old && r.status === "published")
        ? old
        : (ruleData.items.find((r) => r.status === "published")?.id ?? ""),
    );
  }

  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (value) {
      fail(value);
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  }

  useEffect(() => {
    live.current = true;
    if (canRead) void run(load);
    return () => {
      live.current = false;
    };
  }, [base, canRead]);

  const platformName = (id: string) => {
    const p = platforms.find((item) => item.id === id);
    return p ? `${p.display_name} (${p.code})` : `Platform ${id.slice(0, 8)}`;
  };
  const ruleName = (id: string) =>
    rules.find((rule) => rule.id === id)?.name ?? `档位 ${id.slice(0, 8)}`;

  if (!canRead)
    return (
      <section className="empty">你没有查看兑换配置与库存的权限。</section>
    );

  async function previewRule(form: HTMLFormElement) {
    const data = new FormData(form);
    await run(async () => {
      const result = await request<Preview>(
        base + "/redemption-rules/preview",
        json(
          {
            platformId: data.get("platformId"),
            tierKey: data.get("tierKey"),
            name: data.get("name"),
            pointsCost: Number(data.get("pointsCost")),
            faceValue: data.get("faceValue"),
            currency: data.get("currency"),
            effectiveFrom: data.get("effectiveFrom"),
            effectiveUntil: data.get("effectiveUntil") || null,
          },
          csrf,
        ),
      );
      if (live.current) setPreview(result);
    });
  }

  async function createRule() {
    if (!preview) return;
    await run(async () => {
      const rule = preview.rule;
      await request(
        base + "/redemption-rules",
        json(
          {
            platformId: rule.platformId,
            tierKey: rule.tierKey,
            name: rule.name,
            pointsCost: rule.pointsCost,
            faceValue: rule.faceValue,
            currency: rule.currency,
            effectiveFrom: rule.effectiveFrom,
            effectiveUntil: rule.effectiveUntil,
          },
          csrf,
        ),
      );
      if (live.current) {
        setPreview(null);
        setRuleOpen(false);
        setNotice("固定兑换档位草稿已创建，请核对后再发布。");
      }
      await load();
    });
  }

  async function changeRule(id: string, action: "publish" | "disable") {
    if (
      !window.confirm(
        action === "publish"
          ? "确认发布该固定兑换档位？发布后规则内容不可修改。"
          : "确认停用该固定兑换档位？停用后不再用于新兑换。",
      )
    )
      return;
    await run(async () => {
      await request(base + `/redemption-rules/${id}/${action}`, json({}, csrf));
      if (live.current)
        setNotice(action === "publish" ? "档位已发布。" : "档位已停用。");
      await load();
    });
  }

  async function importCodes() {
    const parsed = parseCodeLines(codes);
    if (!ruleId || !parsed.length) {
      setError("请选择已发布档位，并提供至少一个兑换码。");
      return;
    }
    if (parsed.length > 500) {
      setError("单批最多导入 500 个兑换码。");
      return;
    }
    if (
      expiresAt &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        expiresAt,
      ) ||
        Number.isNaN(Date.parse(expiresAt)))
    ) {
      setError("到期时间必须是包含时区的 ISO 8601 时间。");
      return;
    }
    await run(async () => {
      const result = await request<ImportResult>(
        base + "/redemption-code-batches",
        json(
          {
            ruleId,
            codes: parsed.map((code) => ({
              code,
              expiresAt: expiresAt || null,
            })),
          },
          csrf,
        ),
      );
      if (live.current) {
        setImportResult(result);
        setCodes("");
        setExpiresAt("");
        setNotice(
          result.status === "imported"
            ? `已安全导入 ${result.imported_count} 个兑换码。`
            : `整批未导入：发现 ${result.duplicate_count} 个同平台重复码。`,
        );
      }
      await load();
    });
  }

  return (
    <section className="panel redemption-admin">
      <div className="table-title">
        <div>
          <h2>固定兑换档位与兑换码库存</h2>
          <p className="muted">
            兑换码按平台隔离并加密保存；普通页面、导入记录和日志均不回显完整兑换码。
          </p>
        </div>
        <span>
          {canRules && (
            <button disabled={busy} onClick={() => setRuleOpen(true)}>
              新建固定档位
            </button>
          )}{" "}
          {canInventory && (
            <button disabled={busy} onClick={() => setImportOpen(true)}>
              批量导入兑换码
            </button>
          )}{" "}
          <button disabled={busy} onClick={() => void run(load)}>
            刷新
          </button>
        </span>
      </div>
      {busy && <p role="status">正在加载…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <h3>固定兑换档位</h3>
      {!rules.length ? (
        <p className="empty">暂无固定兑换档位。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>平台</th>
                <th>档位</th>
                <th>面额</th>
                <th>Points 成本</th>
                <th>有效窗口</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td>{platformName(rule.platform_id)}</td>
                  <td>
                    <b>{rule.name}</b>
                    <small className="muted">
                      {" "}
                      · {rule.tier_key} · V{rule.version}
                    </small>
                  </td>
                  <td>
                    {rule.face_value} {rule.face_currency}
                  </td>
                  <td>{rule.points_cost}</td>
                  <td>
                    {rule.effective_from} → {rule.effective_until ?? "长期"}
                  </td>
                  <td>{statusText[rule.status]}</td>
                  <td>
                    {canRules && rule.status === "draft" && (
                      <button
                        disabled={busy}
                        onClick={() => void changeRule(rule.id, "publish")}
                      >
                        发布
                      </button>
                    )}
                    {canRules && rule.status === "published" && (
                      <button
                        disabled={busy}
                        onClick={() => void changeRule(rule.id, "disable")}
                      >
                        停用
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>库存状态</h3>
      {!inventory.length ? (
        <p className="empty">当前范围暂无兑换码库存。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>平台 / 档位</th>
                <th>总数</th>
                <th>可用</th>
                <th>过期</th>
                <th>禁用</th>
                <th>已分配</th>
                <th>已领取</th>
              </tr>
            </thead>
            <tbody>
              {inventory.map((row) => (
                <tr key={`${row.platform_id}:${row.rule_id}`}>
                  <td>
                    {platformName(row.platform_id)} / {ruleName(row.rule_id)}
                  </td>
                  <td>{row.total}</td>
                  <td>{row.available}</td>
                  <td>{row.expired}</td>
                  <td>{row.disabled}</td>
                  <td>{row.assigned}</td>
                  <td>{row.claimed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>最近导入结果</h3>
      {!batches.length ? (
        <p className="empty">暂无导入记录。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>平台 / 档位</th>
                <th>状态</th>
                <th>总数</th>
                <th>成功</th>
                <th>重复</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.id}>
                  <td>{safeDate(batch.created_at)}</td>
                  <td>
                    {platformName(batch.platform_id)} /{" "}
                    {ruleName(batch.rule_id)}
                  </td>
                  <td>{batchText[batch.status]}</td>
                  <td>{batch.total_count}</td>
                  <td>{batch.imported_count}</td>
                  <td>{batch.duplicate_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ruleOpen && (
        <div className="detail-overlay">
          <section
            className="detail"
            role="dialog"
            aria-label="新建固定兑换档位"
          >
            <div className="table-title">
              <h2>新建固定兑换档位</h2>
              <button
                onClick={() => {
                  setRuleOpen(false);
                  setPreview(null);
                }}
              >
                关闭
              </button>
            </div>
            {!preview ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void previewRule(event.currentTarget);
                }}
              >
                <label>
                  平台
                  <select name="platformId" required defaultValue="">
                    <option value="" disabled>
                      请选择平台
                    </option>
                    {platforms
                      .filter((p) => p.status === "active")
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.display_name} ({p.code})
                        </option>
                      ))}
                  </select>
                </label>
                {!platforms.length && (
                  <p className="muted">需要平台读取权限才能创建档位。</p>
                )}
                <label>
                  档位标识
                  <input
                    name="tierKey"
                    required
                    pattern="[a-z0-9_-]{1,64}"
                    placeholder="例如 brl_10"
                  />
                </label>
                <label>
                  显示名称
                  <input name="name" required maxLength={120} />
                </label>
                <label>
                  Points 成本
                  <input
                    name="pointsCost"
                    type="number"
                    min="1"
                    max="300"
                    required
                  />
                </label>
                <label>
                  兑换码面额
                  <input name="faceValue" inputMode="decimal" required />
                </label>
                <label>
                  币种
                  <input
                    name="currency"
                    pattern="[A-Z]{3}"
                    required
                    placeholder="BRL"
                  />
                </label>
                <label>
                  生效日期
                  <input name="effectiveFrom" type="date" required />
                </label>
                <label>
                  结束日期（可选）
                  <input name="effectiveUntil" type="date" />
                </label>
                <button disabled={busy || !platforms.length}>预览</button>
              </form>
            ) : (
              <div>
                <p>
                  <b>{preview.rule.name}</b>
                </p>
                <p>
                  {preview.rule.faceValue} {preview.rule.currency} ·{" "}
                  {preview.rule.pointsCost} Points
                </p>
                <p>
                  每日最多 {preview.rule.dailyCountLimit} 次 /{" "}
                  {preview.rule.dailyPointsLimit} Points · 无充值校验
                </p>
                <p>业务时区：{preview.rule.timezone}</p>
                <button disabled={busy} onClick={() => setPreview(null)}>
                  返回修改
                </button>{" "}
                <button disabled={busy} onClick={() => void createRule()}>
                  创建草稿
                </button>
              </div>
            )}
          </section>
        </div>
      )}

      {importOpen && (
        <div className="detail-overlay">
          <section className="detail" role="dialog" aria-label="批量导入兑换码">
            <div className="table-title">
              <h2>批量导入兑换码</h2>
              <button
                onClick={() => {
                  setImportOpen(false);
                  setCodes("");
                }}
              >
                关闭
              </button>
            </div>
            <p className="muted">
              选择已发布档位，每行粘贴一个兑换码。提交后输入内容会立即清空，列表只显示数量。
            </p>
            <label>
              已发布档位
              <select
                value={ruleId}
                onChange={(event) => setRuleId(event.target.value)}
              >
                <option value="">请选择</option>
                {rules
                  .filter((rule) => rule.status === "published")
                  .map((rule) => (
                    <option key={rule.id} value={rule.id}>
                      {platformName(rule.platform_id)} / {rule.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              兑换码（每行一个，最多 500 个）
              <textarea
                aria-label="兑换码（每行一个，最多 500 个）"
                rows={10}
                value={codes}
                onChange={(event) => setCodes(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              统一到期时间（可选，ISO 8601，需含时区）
              <input
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                placeholder="2026-12-31T23:59:59-03:00"
              />
            </label>
            {importResult && (
              <p role="status">
                上次结果：{batchText[importResult.status]}；成功{" "}
                {importResult.imported_count}；重复{" "}
                {importResult.duplicate_count}。
              </p>
            )}
            <button disabled={busy} onClick={() => void importCodes()}>
              确认导入
            </button>
          </section>
        </div>
      )}
    </section>
  );
}
