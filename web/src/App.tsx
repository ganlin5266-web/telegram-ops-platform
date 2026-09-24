import { useEffect, useRef, useState } from "react";
import { ApiError, json, operation, request, type Operation } from "./api";
import UsersCenter from "./operations/UsersCenter";
import {
  UserOverview,
  PointSummary,
  LedgerPanel,
  ReferralPanel,
  AuditPanel,
} from "./operations/panels";
type Me = { displayName: string; uiLanguage: string; csrfToken: string };
type Brand = {
  brandId: string;
  name: string;
  status: string;
  defaultLanguage: string;
};
type Bot = {
  botId: string;
  name: string;
  username: string;
  status: string;
  defaultLanguage: string;
};
type User = {
  id: string;
  telegram_user_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  preferred_language: string | null;
  telegram_language_code: string | null;
  first_started_at: string | null;
  last_interaction_at: string | null;
  status: string;
};
const date = (s: string | null) =>
  s ? new Date(s).toLocaleString("zh-CN") : "暂无数据";
export default function App() {
  const [me, setMe] = useState<Me | null>(null),
    [boot, setBoot] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [login, setLogin] = useState(""),
    [password, setPassword] = useState("");
  const [brands, setBrands] = useState<Brand[]>([]),
    [brand, setBrand] = useState(""),
    [bots, setBots] = useState<Bot[]>([]),
    [bot, setBot] = useState("");
  const [page, setPage] = useState("overview"),
    [drawer, setDrawer] = useState(false),
    [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false),
    [scopeError, setScopeError] = useState("");
  const [detailTab, setDetailTab] = useState("points"),
    [pointsRevision, setPointsRevision] = useState(0);
  const [selected, setSelected] = useState<User | null>(null),
    [balance, setBalance] = useState<string | null>(null),
    [pointBusy, setPointBusy] = useState(false),
    [pointError, setPointError] = useState("");
  const [delta, setDelta] = useState(""),
    [reason, setReason] = useState(""),
    [remarks, setRemarks] = useState(""),
    [pending, setPending] = useState<Operation | null>(null),
    [result, setResult] = useState(""),
    [sending, setSending] = useState(false);
  const generation = useRef(0),
    detailGeneration = useRef(0),
    session = useRef(0),
    submitLock = useRef(false);
  const base = `/v1/brands/${brand}/bots/${bot}`;
  function clearDetails() {
    detailGeneration.current++;
    setSelected(null);
    setBalance(null);
    setPointError("");
    setPointBusy(false);
    setDelta("");
    setReason("");
    setRemarks("");
    setPending(null);
    setResult("");
    setSending(false);
  }
  function clearScope() {
    generation.current++;
    clearDetails();
    setPermissions([]);
    setScopeError("");
  }
  function expire() {
    session.current++;
    clearScope();
    setMe(null);
    setPage("overview");
    setDrawer(false);
    setPassword("");
    setLogin("");
    setBrands([]);
    setBots([]);
    setBrand("");
    setBot("");
    setError("登录已过期，请重新登录");
    setLoading(false);
    setBoot(false);
  }
  function failed(e: unknown, set: (s: string) => void) {
    if (
      e instanceof ApiError &&
      ((e.status === 401 && e.code !== "invalid_credentials") ||
        e.code === "csrf_failed")
    )
      expire();
    else {
      const text = e instanceof Error ? e.message : "请求失败，请重试";
      if (e instanceof ApiError && e.status === 403) {
        clearScope();
        setLoading(false);
        setScopeError(text);
      }
      set(text);
    }
  }
  async function initialize() {
    const epoch = ++session.current;
    clearScope();
    setMe(null);
    setBrand("");
    setBot("");
    setBots([]);
    setBrands([]);
    setBoot(true);
    setError("");
    try {
      const profile = await request<Me>("/v1/me");
      await request("/v1/me/permissions");
      const list = await request<{ items: Brand[] }>("/v1/me/brands");
      if (epoch !== session.current) return;
      setMe(profile);
      setBrands(list.items);
      setBrand(list.items[0]?.brandId || "");
    } catch (e) {
      if (epoch === session.current) failed(e, setError);
    } finally {
      if (epoch === session.current) setBoot(false);
    }
  }
  useEffect(() => {
    void initialize();
    return () => {
      session.current++;
      generation.current++;
      detailGeneration.current++;
    };
  }, []);
  useEffect(() => {
    if (!me || !brand) return;
    const version = generation.current;
    let active = true;
    setLoading(true);
    request<{ items: Bot[] }>(`/v1/me/brands/${brand}/bots`)
      .then((r) => {
        if (active && version === generation.current) {
          setBots(r.items);
          setBot(r.items[0]?.botId || "");
        }
      })
      .catch((e) => {
        if (active && version === generation.current) failed(e, setScopeError);
      })
      .finally(() => {
        if (active && version === generation.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [me, brand]);
  useEffect(() => {
    if (!me || !bot) return;
    let active = true;
    const version = generation.current;
    setLoading(true);
    request<{ permissions: string[] }>(
      `/v1/me/permissions?brandId=${brand}&botId=${bot}`,
    )
      .then((r) => {
        if (active && version === generation.current)
          setPermissions(r.permissions);
      })
      .catch((e) => {
        if (active && version === generation.current) failed(e, setScopeError);
      })
      .finally(() => {
        if (active && version === generation.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [me, brand, bot]);
  async function points(user: User, tab = "points") {
    clearDetails();
    setSelected(user);
    setDetailTab(tab);
    setPointsRevision(0);
    const version = detailGeneration.current;
    setPointBusy(true);
    try {
      const r = await request<{ balance: string }>(
        `${base}/users/${user.id}/points`,
      );
      if (version === detailGeneration.current) setBalance(r.balance);
    } catch (e) {
      if (version === detailGeneration.current) failed(e, setPointError);
    } finally {
      if (version === detailGeneration.current) setPointBusy(false);
    }
  }
  async function adjust() {
    if (!pending || !me || submitLock.current) return;
    const version = detailGeneration.current;
    const op = pending;
    submitLock.current = true;
    setSending(true);
    setPointError("");
    try {
      await request(`${base}/points/adjustments`, {
        ...json(op.body, me.csrfToken),
        headers: {
          ...json({}, me.csrfToken).headers,
          "Idempotency-Key": op.key,
        },
      });
      if (version !== detailGeneration.current) return;
      setPending(null);
      setPointsRevision((x) => x + 1);
      setResult("积分调整成功，服务端已记录流水。");
      setBalance(null);
      setDelta("");
      setReason("");
      setRemarks("");
      const r = await request<{ balance: string }>(
        `${base}/users/${op.body.userId}/points`,
      );
      if (version === detailGeneration.current) setBalance(r.balance);
    } catch (e) {
      if (version === detailGeneration.current) failed(e, setPointError);
    } finally {
      submitLock.current = false;
      if (version === detailGeneration.current) setSending(false);
    }
  }
  useEffect(() => {
    if (!selected) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>("[role=dialog]");
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)",
        ) || [],
      );
    focusable()[0]?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      previous?.focus();
    };
  }, [selected]);
  const currentBrand = brands.find((x) => x.brandId === brand),
    currentBot = bots.find((x) => x.botId === bot);
  const alert = (s: string) =>
    s ? (
      <div className="alert" role="alert">
        {s}
      </div>
    ) : null;
  if (boot)
    return (
      <div className="center" role="status">
        正在连接运营工作台…
      </div>
    );
  if (!me)
    return (
      <div className="login">
        <section className="login-intro">
          <div className="logo">
            T<span>OPS / 运营工作台</span>
          </div>
          <h1>
            让每一次运营
            <br />
            都有据可循。
          </h1>
          <p>
            统一管理 Telegram 用户与积分，
            <br />
            在明确的品牌和 Bot 范围内开展工作。
          </p>
          <small>TELEGRAM OPERATIONS PLATFORM</small>
        </section>
        <main className="login-form">
          <div className="eyebrow">管理员入口</div>
          <h2>欢迎回来</h2>
          <p className="muted">使用管理员账号登录运营工作台</p>
          {alert(error)}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              const submitted = password;
              setPassword("");
              try {
                await request(
                  "/v1/auth/login",
                  json({ login, password: submitted }),
                );
                await initialize();
              } catch (e) {
                failed(e, setError);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              账号
              <input
                autoComplete="username"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                required
              />
            </label>
            <label>
              密码
              <input
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button className="primary" disabled={busy}>
              {busy ? "正在登录…" : "登录工作台 →"}
            </button>
          </form>
          <small>仅限已授权管理员 · 安全会话认证</small>
          {error && (
            <button className="text" onClick={() => void initialize()}>
              重新检查会话
            </button>
          )}
        </main>
      </div>
    );
  return (
    <div className="shell">
      {drawer && (
        <button
          className="scrim"
          aria-label="关闭导航"
          onClick={() => setDrawer(false)}
        />
      )}
      <aside className={drawer ? "sidebar open" : "sidebar"}>
        <div className="logo">
          T
          <span>
            OPS<span className="muted">运营工作台</span>
          </span>
        </div>
        <div className="nav-caption">工作空间</div>
        <nav>
          {[
            ["overview", "◫", "总览"],
            ["users", "◎", "Telegram 用户"],
          ].map(([id, icon, title]) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              onClick={() => {
                setPage(id);
                setDrawer(false);
                clearDetails();
              }}
            >
              <span>{icon}</span>
              {title}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          安全的运营边界
          <br />
          <small>业务操作由服务端验证并记录</small>
        </div>
      </aside>
      <div className="workspace">
        <header>
          <button
            className="mobile"
            aria-label="打开导航"
            onClick={() => setDrawer(true)}
          >
            ☰
          </button>
          <label>
            品牌
            <select
              aria-label="品牌"
              value={brand}
              onChange={(e) => {
                clearScope();
                setBots([]);
                setBot("");
                setBrand(e.target.value);
              }}
            >
              {!brands.length && <option value="">暂无品牌</option>}
              {brands.map((x) => (
                <option key={x.brandId} value={x.brandId}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Telegram Bot
            <select
              aria-label="Telegram Bot"
              value={bot}
              onChange={(e) => {
                clearScope();
                setBot(e.target.value);
              }}
            >
              {!bots.length && <option value="">暂无 Bot</option>}
              {bots.map((x) => (
                <option key={x.botId} value={x.botId}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <div className="admin">
            <span className="avatar">{me.displayName.slice(0, 1)}</span>
            <div>
              {me.displayName}
              <small>简体中文 · {me.uiLanguage}</small>
            </div>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await request("/v1/auth/logout", json({}, me.csrfToken));
                  expire();
                  setError("已安全退出");
                } catch (e) {
                  failed(e, setError);
                } finally {
                  setBusy(false);
                }
              }}
            >
              退出
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                WORKSPACE /{" "}
                {page === "overview" ? "OVERVIEW" : "TELEGRAM USERS"}
              </div>
              <h1>{page === "overview" ? "工作台总览" : "Telegram 用户"}</h1>
              <p className="muted">
                {page === "overview"
                  ? "查看当前身份、运营范围与连接状态。"
                  : "查看当前 Bot 用户，读取余额或进行授权积分调整。"}
              </p>
            </div>
            <span className="badge">中文管理后台</span>
          </div>
          {alert(error)}
          {alert(scopeError)}
          {scopeError && (
            <button onClick={() => void initialize()}>重新加载授权范围</button>
          )}
          {loading && <p role="status">正在加载…</p>}
          {!brands.length ? (
            <section className="empty">
              当前账号暂无可访问品牌，请联系管理员。
            </section>
          ) : !bots.length && !loading && !scopeError ? (
            <section className="empty">当前品牌暂无可访问Bot。</section>
          ) : null}
          {page === "overview" ? (
            <>
              <div className="cards">
                <section>
                  <div className="eyebrow">当前管理员</div>
                  <h2>{me.displayName}</h2>
                  <p>后台界面：简体中文</p>
                  <span className="badge green">Session 已认证</span>
                </section>
                <section>
                  <div className="eyebrow">品牌范围</div>
                  <h2>{currentBrand?.name || "暂无数据"}</h2>
                  <p>状态：{currentBrand?.status || "暂无数据"}</p>
                  <small>
                    默认语言：{currentBrand?.defaultLanguage || "暂无数据"}
                  </small>
                </section>
                <section>
                  <div className="eyebrow">当前 TELEGRAM BOT</div>
                  <h2>{currentBot?.name || "暂无数据"}</h2>
                  <p>
                    {currentBot?.username
                      ? `@${currentBot.username}`
                      : "暂无 Username"}
                  </p>
                  <small>
                    状态：{currentBot?.status || "暂无数据"} · 默认语言：
                    {currentBot?.defaultLanguage || "暂无数据"}
                  </small>
                </section>
              </div>
              <section className="panel">
                <h3>系统与访问状态</h3>
                <div className="info-row">
                  <span>管理 API</span>
                  <span>已完成身份与授权品牌读取</span>
                </div>
                <div className="info-row">
                  <span>当前范围权限</span>
                  <span>
                    {loading ? "加载中" : permissions.join("、") || "暂无权限"}
                  </span>
                </div>
                <div className="info-row">
                  <span>运营指标 / Webhook 实时状态</span>
                  <span className="muted">尚未开放</span>
                </div>
                <div className="language-note">
                  后台中文仅用于管理界面。Telegram
                  发送语言由服务端按用户偏好、Telegram 语言、Bot
                  与品牌默认语言解析。
                </div>
              </section>
            </>
          ) : bot &&
            !loading &&
            !scopeError &&
            !permissions.includes("users.read") ? (
            <section className="empty">你没有权限查看当前 Bot 用户。</section>
          ) : bot && permissions.includes("users.read") ? (
            <UsersCenter
              key={base}
              base={base}
              botName={currentBot?.name || ""}
              onSelect={(user, tab) => void points(user, tab)}
              onInvalidate={clearDetails}
              onExpire={expire}
            />
          ) : null}
        </main>
        <footer>
          Telegram Operations Platform <span>第二批 · 用户运营中心</span>
        </footer>
      </div>
      {selected && (
        <div className="detail-overlay">
          <section
            className="detail operations-detail"
            role="dialog"
            aria-modal="true"
            aria-label="用户详情"
          >
            <div className="table-title">
              <h2>用户详情</h2>
              <button
                aria-label="关闭详情"
                disabled={sending}
                onClick={() => {
                  if (
                    !pending ||
                    !pointError ||
                    window.confirm(
                      "操作结果尚未确认。关闭会丢弃本次重试标识，请先核对余额及流水，避免重复调整。",
                    )
                  )
                    clearDetails();
                }}
              >
                ×
              </button>
            </div>
            <p>
              {currentBrand?.name} / {currentBot?.name}
            </p>
            <h3>
              {selected.first_name || selected.username || "Telegram 用户"}
            </h3>
            <small>Telegram ID：{selected.telegram_user_id}</small>
            <div className="balance">
              <span>当前积分余额</span>
              <strong>{pointBusy ? "读取中…" : (balance ?? "暂无数据")}</strong>
            </div>
            <PointSummary
              key={`${base}/${selected.id}`}
              base={base}
              userId={selected.id}
              revision={pointsRevision}
              onExpire={expire}
            />
            <div className="tabs" role="tablist" aria-label="用户详情栏目">
              {[
                ["overview", "概览"],
                ["points", "积分"],
                ["referrals", "邀请"],
                ...(permissions.includes("audit.read")
                  ? [["audit", "操作记录"]]
                  : []),
              ].map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={detailTab === id}
                  onClick={() => setDetailTab(id!)}
                >
                  {label}
                </button>
              ))}
            </div>
            {detailTab === "overview" && (
              <UserOverview
                key={`${base}/${selected.id}`}
                base={base}
                userId={selected.id}
                onExpire={expire}
              />
            )}
            {detailTab === "points" && (
              <LedgerPanel
                key={`${base}/${selected.id}`}
                base={base}
                userId={selected.id}
                revision={pointsRevision}
                onExpire={expire}
              />
            )}
            {detailTab === "referrals" && (
              <ReferralPanel
                key={`${base}/${selected.id}`}
                base={base}
                userId={selected.id}
                onExpire={expire}
              />
            )}
            {detailTab === "audit" && permissions.includes("audit.read") && (
              <AuditPanel key={base} base={base} onExpire={expire} />
            )}
            {alert(pointError)}
            {pointError && !pending && (
              <button onClick={() => void points(selected)}>
                重新读取余额
              </button>
            )}
            {result && (
              <div className="success" role="status">
                {result}
              </div>
            )}
            {detailTab === "points" &&
              permissions.includes("points.adjust") &&
              balance !== null &&
              !result && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    try {
                      setPending(
                        operation(selected.id, delta, reason, remarks),
                      );
                      setPointError("");
                    } catch (e) {
                      failed(e, setPointError);
                    }
                  }}
                >
                  <h3>人工调整积分</h3>
                  <fieldset disabled={!!pending || sending}>
                    <label>
                      调整数量（正数增加，负数扣除）
                      <input
                        aria-label="调整数量"
                        value={delta}
                        onChange={(e) => setDelta(e.target.value)}
                        required
                        maxLength={20}
                      />
                    </label>
                    <label>
                      原因
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        required
                        maxLength={497}
                      />
                    </label>
                    <label>
                      补充备注
                      <textarea
                        value={remarks}
                        onChange={(e) => setRemarks(e.target.value)}
                        maxLength={497}
                      />
                    </label>
                  </fieldset>
                  <p>
                    预计调整后余额：
                    <strong>
                      {/^-?[0-9]+$/.test(delta)
                        ? (BigInt(balance) + BigInt(delta)).toString()
                        : "—"}
                    </strong>
                  </p>
                  <small>预计余额仅供确认，实际以服务端事务结果为准。</small>
                  {!pending && (
                    <button className="primary">调整积分 · 下一步</button>
                  )}
                </form>
              )}
            {pending && (
              <div className="confirm">
                <h3>请再次确认积分调整</h3>
                <p>
                  {currentBrand?.name} / {currentBot?.name} /{" "}
                  {selected.telegram_user_id}
                </p>
                <p>调整数量：{pending.body.delta}</p>
                <p className="pre">{pending.body.note}</p>
                <p>失败后重试保留同一操作标识，避免重复入账。</p>
                <button
                  className="primary"
                  disabled={sending}
                  onClick={() => void adjust()}
                >
                  {sending
                    ? "正在提交…"
                    : pointError
                      ? "使用原操作重试"
                      : "确认提交"}
                </button>
                {!pointError && (
                  <button disabled={sending} onClick={() => setPending(null)}>
                    返回修改
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
