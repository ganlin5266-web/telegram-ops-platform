import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient, MiniError, type Home, type Page } from "./client";
import { messages } from "./i18n";
import "./style.css";
const client = createClient();
const tabs = ["首页", "活动", "奖励", "邀请", "我的"] as const;
export function MiniApp() {
  const [tab, setTab] = useState<(typeof tabs)[number]>("首页"),
    [home, setHome] = useState<Home>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<MiniError>(),
    [out, setOut] = useState(false),
    [kind, setKind] = useState<"point-ledger" | "referrals" | "redemptions">(
      "point-ledger",
    ),
    [page, setPage] = useState<Page>(),
    [help, setHelp] = useState(false);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof MiniError ? e : new MiniError("invalid_json"));
    } finally {
      setBusy(false);
    }
  }
  const load = () =>
    run(async () => {
      if (!client.connected)
        await client.connect(window.Telegram?.WebApp?.initData ?? "");
      setHome(await client.home());
    });
  useEffect(() => {
    window.Telegram?.WebApp?.ready?.();
    void load();
    const forget = () => client.forget();
    window.addEventListener("pagehide", forget);
    return () => window.removeEventListener("pagehide", forget);
  }, []);
  const records = (k: typeof kind, more = false) =>
    run(async () => {
      const next = await client.page(
        k,
        more ? (page?.nextCursor ?? undefined) : undefined,
      );
      setPage(
        more
          ? { ...next, items: [...(page?.items ?? []), ...next.items] }
          : next,
      );
    });
  function select(t: typeof tab) {
    setTab(t);
    setPage(undefined);
    setError(undefined);
    setHelp(false);
    if (t === "奖励") {
      setKind("point-ledger");
      void records("point-ledger");
    }
    if (t === "邀请") {
      setKind("referrals");
      void records("referrals");
    }
  }
  const balance = home?.points.accountExists
    ? home.points.balance
    : "暂无积分账户";
  const history = (
    <section className="card">
      <h2>
        {kind === "point-ledger"
          ? "积分流水"
          : kind === "referrals"
            ? "邀请记录"
            : "兑换记录"}
      </h2>
      {page?.items.length === 0 && (
        <p className="muted">
          {kind === "point-ledger"
            ? "暂无积分记录"
            : kind === "referrals"
              ? "暂无邀请记录"
              : "暂无兑换记录"}
        </p>
      )}
      {page?.items.map((r) => (
        <article className="record" key={r.id}>
          <div>
            <strong>
              {kind === "point-ledger"
                ? r.delta?.startsWith("-")
                  ? "积分支出"
                  : "积分收入"
                : kind === "referrals"
                  ? "邀请关系"
                  : "兑换申请"}
            </strong>
            <small>{new Date(r.created_at).toLocaleString("zh-CN")}</small>
          </div>
          <div>
            {r.delta ? (
              <strong className={r.delta.startsWith("-") ? "" : "positive"}>
                {r.delta.startsWith("-") ? "" : "+"}
                {r.delta}
              </strong>
            ) : r.points_cost ? (
              <strong>{r.points_cost} 积分</strong>
            ) : null}
            <small>
              {r.status
                ? ((
                    {
                      bound: "已绑定",
                      qualified: "已满足条件",
                      invalid: "无效",
                      pending: "待处理",
                      processing: "处理中",
                      success: "已完成",
                      failed: "未完成",
                      cancelled: "已取消",
                    } as Record<string, string>
                  )[r.status] ?? "已记录")
                : "已入账"}
            </small>
          </div>
        </article>
      ))}
      {page?.nextCursor && (
        <button disabled={busy} onClick={() => void records(kind, true)}>
          查看更多
        </button>
      )}
    </section>
  );
  return (
    <div className="mini-shell">
      <header>
        <span className="eyebrow">
          FUN CLUB <span>STAGING</span>
        </span>
        <span className="avatar" aria-hidden="true">
          {home?.profile.displayName.slice(0, 1) || "F"}
        </span>
      </header>
      {!home || out ? (
        <main>
          <section className="hero">
            <p className="eyebrow">你的专属服务空间</p>
            <h1>{out ? "已安全退出" : "欢迎来到 FUN Club"}</h1>
            <p>查看积分与记录，了解最新活动。你的身份由 Telegram 安全验证。</p>
            {!out && (
              <button disabled={busy} onClick={() => void load()}>
                {busy ? "正在连接…" : "连接 Telegram 身份"}
              </button>
            )}
            {out && <p>需要再次登录时，请关闭并从 Bot 重新打开。</p>}
          </section>
        </main>
      ) : (
        <main>
          <div className="title">
            <p className="eyebrow">{home.profile.projectName}</p>
            <h1>
              {tab === "首页" ? `你好，${home.profile.displayName}` : tab}
            </h1>
          </div>
          {tab === "首页" && (
            <>
              <section className="hero">
                <span className="pill">我的积分</span>
                <div className="balance">{balance}</div>
                <p>每笔积分都有记录。具体用途以已公布的活动与兑换规则为准。</p>
                <button onClick={() => select("奖励")}>查看我的积分</button>
              </section>
              <div className="summary">
                <button onClick={() => select("邀请")}>
                  <strong>{home.invitedCount}</strong>
                  <span>已邀请人数</span>
                </button>
                <button
                  onClick={() => {
                    select("奖励");
                    setKind("redemptions");
                    void records("redemptions");
                  }}
                >
                  <strong>{home.redemptionCount}</strong>
                  <span>兑换记录</span>
                </button>
              </div>
              <section className="card">
                <span className="eyebrow">接下来</span>
                <h2>好活动，值得期待</h2>
                <p className="muted">
                  当前暂无可参加活动。活动开放后，可在这里查看。
                </p>
                <button className="text-button" onClick={() => select("活动")}>
                  前往活动中心 →
                </button>
              </section>
            </>
          )}
          {tab === "活动" && (
            <section className="card empty">
              <span className="empty-icon" aria-hidden="true">
                ✦
              </span>
              <h2>新的活动正在准备</h2>
              <p>当前暂无可参加活动。</p>
              <p className="muted">活动尚未开放，不会扣除积分或发起奖励。</p>
            </section>
          )}
          {tab === "奖励" && (
            <>
              <section className="hero">
                <span className="pill">当前积分</span>
                <div className="balance">{balance}</div>
                <p>积分按 Bot 独立记录。当前仅支持查看，不开放兑换申请。</p>
              </section>
              <div className="segmented">
                <button
                  aria-pressed={kind === "point-ledger"}
                  onClick={() => {
                    setKind("point-ledger");
                    setPage(undefined);
                    void records("point-ledger");
                  }}
                >
                  积分流水
                </button>
                <button
                  aria-pressed={kind === "redemptions"}
                  onClick={() => {
                    setKind("redemptions");
                    setPage(undefined);
                    void records("redemptions");
                  }}
                >
                  兑换记录
                </button>
              </div>
              {history}
            </>
          )}
          {tab === "邀请" && (
            <>
              <section className="hero">
                <span className="pill">一起发现更多</span>
                <h2>我的邀请</h2>
                <div className="balance">
                  {home.invitedCount}
                  <small> 人</small>
                </div>
                <p>
                  邀请奖励以正式公布的有效条件为准，当前不开放新的分享或奖励操作。
                </p>
              </section>
              {history}
            </>
          )}
          {tab === "我的" && (
            <>
              <section className="card">
                <h2>{home.profile.displayName}</h2>
                <p>{home.profile.botName}</p>
                <p className="muted">{home.profile.projectName}</p>
              </section>
              <section className="card links">
                <button onClick={() => select("奖励")}>
                  积分记录 <span>→</span>
                </button>
                <button onClick={() => select("邀请")}>
                  邀请记录 <span>→</span>
                </button>
                <button
                  onClick={() => {
                    select("奖励");
                    setKind("redemptions");
                    void records("redemptions");
                  }}
                >
                  兑换记录 <span>→</span>
                </button>
                <button onClick={() => setHelp(!help)}>
                  语言 · 简体中文 <span>→</span>
                </button>
                <button onClick={() => setHelp(!help)}>
                  帮助 <span>→</span>
                </button>
                {help && (
                  <p className="muted">
                    当前测试版提供简体中文。其他语言正在准备。账户或记录问题请联系项目运营人员；不要发送密码或认证信息。
                  </p>
                )}
              </section>
              <button
                className="logout"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await client.logout();
                    setHome(undefined);
                    setPage(undefined);
                    setOut(true);
                  })
                }
              >
                退出登录
              </button>
            </>
          )}
        </main>
      )}
      {busy && (
        <p role="status" className="notice">
          正在读取，请稍候…
        </p>
      )}
      {error && (
        <aside role="alert" className="notice error">
          <p>{messages[error.kind]}</p>
          {error.requestId && <small>支持编号：{error.requestId}</small>}
          {!out && error.kind !== "unauthorized" && (
            <button
              disabled={busy}
              onClick={() =>
                home && (tab === "奖励" || tab === "邀请")
                  ? void records(kind)
                  : void load()
              }
            >
              重试
            </button>
          )}
        </aside>
      )}
      {home && !out && (
        <nav aria-label="主导航">
          {tabs.map((t, i) => (
            <button
              key={t}
              aria-current={t === tab ? "page" : undefined}
              disabled={busy}
              onClick={() => select(t)}
            >
              <span aria-hidden="true">{["⌂", "✦", "◇", "↗", "○"][i]}</span>
              {t}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
createRoot(document.getElementById("mini-root")!).render(<MiniApp />);
