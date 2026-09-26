import { useEffect, useRef, useState } from "react";
import { ApiError, json, request } from "../api";
type Platform = {
  id: string;
  code: string;
  display_name: string;
  market: string;
  timezone: string;
  currency: string;
  status: string;
  verification_method: string;
};
type Identity = {
  id: string;
  platformName: string;
  uidMasked: string;
  userId: string;
  status: string;
  verificationMethod: string;
  submittedAt: string;
  uid?: string;
  evidenceReference?: string;
  reasonCode?: string;
};
const states: Record<string, string> = {
  pending: "待验证",
  verified: "已验证",
  rejected: "验证失败",
  conflict: "冲突",
  revoked: "已撤销",
};
const reasons: Record<string, string> = {
  evidence_missing: "缺少证明",
  ownership_not_proven: "无法确认归属",
  incorrect_uid: "UID 有误",
  user_request: "用户申请",
  security_review: "安全复核",
};
export default function PlatformCenter({
  base,
  mode,
  permissions,
  csrf,
  onExpire,
}: {
  base: string;
  mode: "platforms" | "identities";
  permissions: string[];
  csrf: string;
  onExpire: () => void;
}) {
  const [platforms, setPlatforms] = useState<Platform[]>([]),
    [items, setItems] = useState<Identity[]>([]),
    [detail, setDetail] = useState<Identity | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [status, setStatus] = useState("pending"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [evidence, setEvidence] = useState(""),
    [reason, setReason] = useState(""),
    [create, setCreate] = useState(false);
  const live = useRef(true),
    lock = useRef(false);
  const canRead = permissions.includes(
      mode === "platforms" ? "platforms.read" : "platform_identities.read",
    ),
    canManage = permissions.includes("platforms.manage"),
    canVerify = permissions.includes("platform_identities.verify");
  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (live.current) {
        if (e instanceof ApiError && e.status === 401) onExpire();
        else setError(e instanceof Error ? e.message : "请求失败");
      }
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function load(next?: string) {
    if (mode === "platforms") {
      const r = await request<{ items: Platform[] }>(base + "/platforms");
      if (live.current) setPlatforms(r.items);
    } else {
      const q = new URLSearchParams();
      if (status) q.set("status", status);
      if (next) q.set("cursor", next);
      const r = await request<{ items: Identity[]; nextCursor: string | null }>(
        base + "/platform-identities?" + q,
      );
      if (live.current) {
        setItems((old) => (next ? [...old, ...r.items] : r.items));
        setCursor(r.nextCursor);
      }
    }
  }
  useEffect(() => {
    live.current = true;
    if (canRead) void run(() => load());
    return () => {
      live.current = false;
    };
  }, [status, canRead]);
  async function review(action: string) {
    await run(async () => {
      if (!detail) return;
      await request(
        base + "/platform-identities/" + detail.id + "/review",
        json(
          {
            action,
            ...(action === "verify"
              ? { evidenceReference: evidence }
              : { reasonCode: reason }),
          },
          csrf,
        ),
      );
      if (live.current) {
        setDetail(null);
        setEvidence("");
        setReason("");
        await load();
      }
    });
  }
  if (!canRead)
    return <section className="empty">你没有权限查看此页面。</section>;
  return (
    <section className="panel">
      <div className="table-title">
        <h2>
          {mode === "platforms" ? "品牌平台配置" : "当前 Bot UID 绑定审核"}
        </h2>
        <button disabled={busy} onClick={() => void run(() => load())}>
          刷新
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">正在加载…</p>}
      {mode === "platforms" ? (
        <>
          <p className="muted">
            平台属于当前品牌。规则创建后固定，停用会阻止新提交和审核通过，不删除绑定历史。
          </p>
          {canManage && (
            <button disabled={busy} onClick={() => setCreate(!create)}>
              新增平台
            </button>
          )}
          {create && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                void run(async () => {
                  await request(
                    base + "/platforms",
                    json(
                      {
                        code: d.get("code"),
                        displayName: d.get("name"),
                        market: d.get("market"),
                        timezone: d.get("timezone"),
                        currency: d.get("currency"),
                        verificationMethod: d.get("method"),
                        uidFormat: d.get("format"),
                        uidCase: d.get("case"),
                        uidMinLength: Number(d.get("min")),
                        uidMaxLength: Number(d.get("max")),
                      },
                      csrf,
                    ),
                  );
                  if (live.current) {
                    setCreate(false);
                    await load();
                  }
                });
              }}
            >
              <div className="cards">
                {[
                  ["code", "平台代码"],
                  ["name", "显示名称"],
                  ["market", "市场（两位大写）"],
                  ["timezone", "业务时区"],
                  ["currency", "币种（三位大写）"],
                ].map(([name, label]) => (
                  <label key={name}>
                    {label}
                    <input
                      name={name}
                      required
                      maxLength={100}
                      disabled={busy}
                    />
                  </label>
                ))}
                <label>
                  验证模式
                  <select name="method">
                    <option value="manual_admin">管理员审核</option>
                    <option value="platform_api">
                      平台 API（预留，暂不可提交）
                    </option>
                    <option value="platform_import">
                      平台导入（预留，暂不可提交）
                    </option>
                    <option value="automation">
                      自动化（预留，暂不可提交）
                    </option>
                  </select>
                </label>
                <label>
                  UID 格式
                  <select name="format">
                    <option value="alphanumeric">
                      字母、数字、下划线、短横线
                    </option>
                    <option value="digits">纯数字</option>
                  </select>
                </label>
                <label>
                  UID 大小写
                  <select name="case">
                    <option value="upper">统一大写</option>
                    <option value="sensitive">区分大小写</option>
                  </select>
                </label>
                <label>
                  最小长度
                  <input
                    name="min"
                    type="number"
                    min={1}
                    max={64}
                    defaultValue={1}
                    required
                  />
                </label>
                <label>
                  最大长度
                  <input
                    name="max"
                    type="number"
                    min={1}
                    max={64}
                    defaultValue={64}
                    required
                  />
                </label>
              </div>
              <button disabled={busy}>创建平台</button>
            </form>
          )}
          <table>
            <thead>
              <tr>
                {[
                  "平台",
                  "市场",
                  "时区",
                  "币种",
                  "状态",
                  "验证模式",
                  "操作",
                ].map((s) => (
                  <th key={s}>{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {platforms.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.display_name}
                    <small>{p.code}</small>
                  </td>
                  <td>{p.market}</td>
                  <td>{p.timezone}</td>
                  <td>{p.currency}</td>
                  <td>{p.status}</td>
                  <td>{p.verification_method}</td>
                  <td>
                    {canManage && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await request(
                              base + "/platforms/" + p.id + "/status",
                              json(
                                {
                                  status:
                                    p.status === "active"
                                      ? "disabled"
                                      : "active",
                                },
                                csrf,
                              ),
                            );
                            await load();
                          })
                        }
                      >
                        {p.status === "active" ? "停用" : "启用"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!busy && !platforms.length && <p>暂无平台</p>}
        </>
      ) : (
        <>
          <label>
            审核状态
            <select
              value={status}
              disabled={busy}
              onChange={(e) => {
                setDetail(null);
                setItems([]);
                setStatus(e.target.value);
              }}
            >
              <option value="">全部</option>
              {Object.entries(states).map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <table>
            <thead>
              <tr>
                {[
                  "平台",
                  "Telegram 用户（内部标识）",
                  "UID",
                  "提交时间",
                  "状态",
                  "验证模式",
                  "操作",
                ].map((s) => (
                  <th key={s}>{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{i.platformName}</td>
                  <td>{i.userId}</td>
                  <td>{i.uidMasked}</td>
                  <td>{new Date(i.submittedAt).toLocaleString("zh-CN")}</td>
                  <td>{states[i.status]}</td>
                  <td>{i.verificationMethod}</td>
                  <td>
                    {canVerify && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const r = await request<Identity>(
                              base + "/platform-identities/" + i.id,
                            );
                            if (live.current) {
                              setDetail(r);
                              setEvidence("");
                              setReason("");
                            }
                          })
                        }
                      >
                        审核详情
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!busy && !items.length && <p>当前条件暂无绑定记录</p>}
          {cursor && (
            <button
              disabled={busy}
              onClick={() => void run(() => load(cursor))}
            >
              加载更多
            </button>
          )}
          {detail && (
            <section aria-label="UID 审核详情">
              <h3>UID 审核详情</h3>
              <p>
                仅授权审核人员可查看完整 UID：<strong>{detail.uid}</strong>
              </p>
              <p>
                {states[detail.status]} · {detail.platformName}
              </p>
              {detail.evidenceReference && (
                <p>证据编号：{detail.evidenceReference}</p>
              )}
              {detail.reasonCode && (
                <p>原因：{reasons[detail.reasonCode] ?? detail.reasonCode}</p>
              )}
              {detail.status === "pending" && (
                <>
                  <label>
                    验证证据编号
                    <input
                      value={evidence}
                      placeholder="CASE-..."
                      maxLength={69}
                      onChange={(e) => setEvidence(e.target.value)}
                    />
                  </label>
                  <p>
                    仅在实际核对身份归属后通过。编号引用受控证据，勿填写 UID
                    或个人资料。
                  </p>
                  <button
                    disabled={busy || !/^CASE-[A-Z0-9-]{1,64}$/.test(evidence)}
                    onClick={() => void review("verify")}
                  >
                    验证通过
                  </button>
                </>
              )}
              {["pending", "verified"].includes(detail.status) && (
                <>
                  <label>
                    处理原因
                    <select
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    >
                      <option value="">请选择原因</option>
                      {Object.entries(reasons).map(([v, t]) => (
                        <option key={v} value={v}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    disabled={busy || !reason}
                    onClick={() =>
                      void review(
                        detail.status === "verified" ? "revoke" : "reject",
                      )
                    }
                  >
                    {detail.status === "verified" ? "撤销绑定" : "拒绝验证"}
                  </button>
                </>
              )}
              <button disabled={busy} onClick={() => setDetail(null)}>
                关闭详情
              </button>
            </section>
          )}
        </>
      )}
    </section>
  );
}
