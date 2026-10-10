// 设置 domain: 国家与市场 / Telegram 资源 / Platform / 数据接入 / 语言 / 高级设置.
// Data-driven; write actions exist only when the caller supplies handlers
// (Preview = in-memory). Runtime without backend CRUD shows 待接入 read-only.
import { useState, type ReactNode } from "react";
import {
  botHomeButtons,
  currencies,
  capKeys,
  capStateText,
  capText,
  datasetText,
  dataStatusText,
  disableBlock,
  languages,
  lifeText,
  marketLabel,
  marketPlatforms,
  setPrimary,
  tgKindText,
  tgStatusText,
  timezones,
  type LifeStatus,
  type Market,
  type MarketScope,
  type Platform,
  type Reward,
  type TgKind,
  type TgResource,
} from "./market";
import { Inventory } from "./Inventory";
import { completenessText } from "./model";
import "./market.css";

export const settingsTabs = [
  "国家与市场",
  "Telegram资源",
  "Platform",
  "数据接入",
  "语言",
  "高级设置",
] as const;
export type SettingsTab = (typeof settingsTabs)[number];

export type ImportStatus =
  "waiting" | "processing" | "confirm" | "done" | "review" | "failed";
export const importText: Record<ImportStatus, string> = {
  waiting: "待上传",
  processing: "处理中",
  confirm: "待确认",
  done: "已完成",
  review: "需复核",
  failed: "失败",
};
export type ImportRow = {
  id: string;
  market: string;
  platform: string;
  day: string;
  file: string;
  status: ImportStatus;
  rows: string | null;
  issues: string | null;
  formatChanged?: boolean;
  /** Backend completeness of the business day (never inferred from row counts). */
  completeness?: import("./model").Completeness;
  /** Required datasets received for the day: dataset key → received. */
  datasets?: Record<string, boolean>;
  updatedAt?: string | null;
};

export type SettingsData = {
  markets: Market[];
  platforms: Platform[];
  resources: TgResource[];
  rewards: Reward[];
  imports: ImportRow[];
};
export type SettingsProps = {
  data: SettingsData;
  scope: MarketScope;
  onScope: (s: MarketScope) => void;
  tab: SettingsTab;
  onTab: (t: SettingsTab) => void;
  /** Present only when a write path exists (Preview memory). Missing = 待接入 / 只读. */
  onData?: (d: SettingsData) => void;
  canEdit: boolean;
  preview?: boolean;
};

export function StatusPill({ s, text }: { s: string; text: string }) {
  return <span className={`mk-pill mk-${s}`}>{text}</span>;
}
function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly T[];
  value: T;
  onChange: (t: T) => void;
  label: string;
}) {
  return (
    <div className="ops-tabs" role="tablist" aria-label={label}>
      {items.map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={t === value}
          onClick={() => onChange(t)}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
function Panel({
  title,
  extra,
  children,
}: {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ops-panel">
      <div className="ops-panel-head">
        <h2>{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  );
}
function Confirm({
  title,
  lines,
  danger,
  onOk,
  onClose,
  okText = "确认",
}: {
  title: string;
  lines: ReactNode[];
  danger?: boolean;
  onOk?: () => void;
  onClose: () => void;
  okText?: string;
}) {
  return (
    <div className="ops-modal" role="dialog" aria-label={title}>
      <div>
        <h3>{title}</h3>
        {lines.map((l, i) => (
          <p key={i} className="ops-muted">
            {l}
          </p>
        ))}
        <div className="mk-actions">
          <button className="ops-ghost" onClick={onClose}>
            取消
          </button>
          {onOk && (
            <button
              className={danger ? "mk-danger" : "ops-primary"}
              onClick={() => {
                onOk();
                onClose();
              }}
            >
              {okText}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
const WriteNote = ({ preview }: { preview?: boolean }) =>
  preview ? (
    <p className="mk-note">
      PREVIEW：新增/编辑只保存在当前页面内存，不写入任何服务器。
    </p>
  ) : (
    <p className="mk-note">配置写入待接入：当前只读。</p>
  );

function Searchable<T>({
  rows,
  keyOf,
  text,
  children,
  placeholder,
  statusOf,
}: {
  rows: T[];
  keyOf: (r: T) => string;
  text: (r: T) => string;
  children: (rows: T[]) => ReactNode;
  placeholder: string;
  statusOf: (r: T) => string;
}) {
  const [q, setQ] = useState("");
  const [st, setSt] = useState("");
  const [hist, setHist] = useState(false);
  const shown = rows.filter(
    (r) =>
      (!q || text(r).toLowerCase().includes(q.toLowerCase())) &&
      (!st || statusOf(r) === st) &&
      (hist || statusOf(r) !== "archived"),
  );
  const all = [...new Set(rows.map(statusOf))];
  return (
    <>
      <div className="ops-filter flat">
        <input
          className="ops-search"
          aria-label="搜索"
          placeholder={placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          aria-label="状态筛选"
          value={st}
          onChange={(e) => setSt(e.target.value)}
        >
          <option value="">全部状态</option>
          {all.map((s) => (
            <option key={s} value={s}>
              {(lifeText as Record<string, string>)[s] ??
                (tgStatusText as Record<string, string>)[s] ??
                s}
            </option>
          ))}
        </select>
        <label className="mk-check">
          <input
            type="checkbox"
            checked={hist}
            onChange={(e) => setHist(e.target.checked)}
          />{" "}
          显示已归档
        </label>
      </div>
      {shown.length ? (
        children(shown)
      ) : (
        <p className="ops-empty">没有符合条件的记录</p>
      )}
    </>
  );
}

// ───────────── 国家与市场 ─────────────
function MarketForm({
  onSave,
  onClose,
}: {
  onSave: (m: Market) => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<Market>({
    code: "",
    name: "",
    localName: "",
    currency: "USD",
    timezone: "UTC",
    status: "draft",
    defaultLanguage: "en",
    languages: ["en"],
  });
  const [step, setStep] = useState(1);
  const ok = /^[A-Z]{2,6}$/.test(f.code) && f.name.trim();
  return (
    <div className="ops-modal" role="dialog" aria-label="新增国家/市场">
      <div className="mk-form">
        <h3>
          新增国家/市场 <small>第 {step} / 3 步</small>
        </h3>
        {step === 1 && (
          <>
            <label>
              国家/市场名称
              <input
                value={f.name}
                onChange={(e) => setF({ ...f, name: e.target.value })}
                placeholder="例如 Colombia"
              />
            </label>
            <label>
              显示名称（用户端）
              <input
                value={f.localName}
                onChange={(e) => setF({ ...f, localName: e.target.value })}
                placeholder="例如 Colombia Club"
              />
            </label>
            <label>
              Market Code
              <input
                value={f.code}
                onChange={(e) =>
                  setF({ ...f, code: e.target.value.toUpperCase() })
                }
                placeholder="例如 CO"
              />
              <small>唯一性由后端校验</small>
            </label>
            <label>
              默认 Currency
              <select
                value={f.currency}
                onChange={(e) => setF({ ...f, currency: e.target.value })}
              >
                {currencies.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              业务 Timezone
              <select
                value={f.timezone}
                onChange={(e) => setF({ ...f, timezone: e.target.value })}
              >
                {timezones.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              默认语言
              <select
                value={f.defaultLanguage}
                onChange={(e) =>
                  setF({
                    ...f,
                    defaultLanguage: e.target.value,
                    languages: [e.target.value],
                  })
                }
              >
                {languages.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <p className="ops-muted small">
              创建后状态为「草稿」，完成 Telegram 与 Platform 配置后再启用。
            </p>
          </>
        )}
        {step === 2 && (
          <p className="ops-muted">
            Telegram（可稍后）：创建后在「Telegram资源」中新增 Bot / Channel /
            Group 并指定 Primary。
          </p>
        )}
        {step === 3 && (
          <p className="ops-muted">
            Platform（可稍后）：创建后在「Platform」中新增该市场的平台，数据接入单独配置。
          </p>
        )}
        <div className="mk-actions">
          <button className="ops-ghost" onClick={onClose}>
            取消
          </button>
          {step > 1 && (
            <button className="ops-ghost" onClick={() => setStep(step - 1)}>
              上一步
            </button>
          )}
          {step < 3 ? (
            <button
              className="ops-primary"
              disabled={!ok}
              onClick={() => setStep(step + 1)}
            >
              下一步
            </button>
          ) : (
            <button
              className="ops-primary"
              disabled={!ok}
              onClick={() => {
                onSave(f);
                onClose();
              }}
            >
              创建草稿
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function lifecycleActions(status: LifeStatus) {
  return status === "archived"
    ? []
    : status === "disabled"
      ? (["active", "archived"] as const)
      : (["disabled", "archived"] as const);
}

function MarketList({
  p,
  open,
}: {
  p: SettingsProps;
  open: (code: string) => void;
}) {
  const { data, onData, canEdit, preview } = p;
  const [add, setAdd] = useState(false);
  const [act, setAct] = useState<{ m: Market; to: LifeStatus } | null>(null);
  const editable = !!onData && canEdit;
  return (
    <Panel
      title="国家与市场"
      extra={
        editable && (
          <button className="ops-primary" onClick={() => setAdd(true)}>
            + 新增国家/市场
          </button>
        )
      }
    >
      <WriteNote preview={preview && editable} />
      <Searchable
        rows={data.markets}
        keyOf={(m) => m.code}
        text={(m) => `${m.name}${m.code}${m.localName ?? ""}`}
        statusOf={(m) => m.status}
        placeholder="搜索国家 / Code"
      >
        {(rows) => (
          <div className="ops-scroll">
            <table className="ops-table mk-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>状态</th>
                  <th>Currency</th>
                  <th className="mk-hide-md">Timezone</th>
                  <th>Primary Bot</th>
                  <th className="mk-hide-md">Primary Channel</th>
                  <th>Platform</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const bot = data.resources.find(
                    (r) => r.market === m.code && r.kind === "bot" && r.primary,
                  );
                  const ch = data.resources.find(
                    (r) =>
                      r.market === m.code && r.kind === "channel" && r.primary,
                  );
                  return (
                    <tr key={m.code}>
                      <td>
                        <b>{marketLabel(m)}</b>
                        {m.localName && <small>{m.localName}</small>}
                      </td>
                      <td>
                        <StatusPill s={m.status} text={lifeText[m.status]} />
                      </td>
                      <td>{m.currency}</td>
                      <td className="mk-hide-md">{m.timezone}</td>
                      <td>
                        {bot?.name ?? <span className="ops-muted">未配置</span>}
                      </td>
                      <td className="mk-hide-md">
                        {ch?.name ?? <span className="ops-muted">未配置</span>}
                      </td>
                      <td>
                        {
                          data.platforms.filter(
                            (x) =>
                              x.market === m.code && x.status !== "archived",
                          ).length
                        }
                      </td>
                      <td className="mk-row-actions">
                        <button
                          className="ops-link"
                          onClick={() => open(m.code)}
                        >
                          查看
                        </button>
                        {editable &&
                          lifecycleActions(m.status).map((to) => (
                            <button
                              key={to}
                              className="ops-link"
                              onClick={() => setAct({ m, to })}
                            >
                              {to === "active"
                                ? "启用"
                                : to === "disabled"
                                  ? "停用"
                                  : "归档"}
                            </button>
                          ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Searchable>
      {add && (
        <MarketForm
          onClose={() => setAdd(false)}
          onSave={(m) => onData!({ ...data, markets: [...data.markets, m] })}
        />
      )}
      {act && (
        <Confirm
          title={`${act.to === "archived" ? "归档" : act.to === "disabled" ? "停用" : "启用"} ${act.m.name}`}
          danger={act.to !== "active"}
          lines={
            act.to === "archived"
              ? [
                  "归档是高风险管理操作：已有用户、会员、Growth、Points、内容与兑换历史会保留，但该市场不再出现在普通选择中。",
                  "正式环境需后端前置检查依赖（BACKEND_PENDING）。",
                ]
              : act.to === "disabled"
                ? ["停用后该市场不作为新业务入口，历史记录仍可查看。"]
                : [
                    "启用前后端应确认 Currency、Timezone、Primary Bot 等必要条件。",
                  ]
          }
          onOk={() =>
            onData!({
              ...data,
              markets: data.markets.map((x) =>
                x.code === act.m.code ? { ...x, status: act.to } : x,
              ),
            })
          }
          onClose={() => setAct(null)}
        />
      )}
    </Panel>
  );
}

const marketTabs = ["基本信息", "Telegram", "Platforms", "高级设置"] as const;
function MarketDetail({
  p,
  code,
  back,
}: {
  p: SettingsProps;
  code: string;
  back: () => void;
}) {
  const m = p.data.markets.find((x) => x.code === code);
  const [t, setT] = useState<(typeof marketTabs)[number]>("基本信息");
  if (!m) return null;
  return (
    <div className="ops">
      <button className="ops-ghost" onClick={back}>
        ← 返回国家与市场
      </button>
      <section className="ops-panel">
        <div className="mk-detail-head">
          <h2>{marketLabel(m)}</h2>
          <StatusPill s={m.status} text={lifeText[m.status]} />
        </div>
        <Tabs
          items={marketTabs}
          value={t}
          onChange={setT}
          label="Market 详情"
        />
        {t === "基本信息" && (
          <dl className="ops-dl">
            <div>
              <dt>显示名称</dt>
              <dd>{m.localName ?? m.name}</dd>
            </div>
            <div>
              <dt>默认 Currency</dt>
              <dd>{m.currency}</dd>
            </div>
            <div>
              <dt>业务 Timezone</dt>
              <dd>{m.timezone}</dd>
            </div>
            <div>
              <dt>默认语言</dt>
              <dd>{m.defaultLanguage ?? "—"}</dd>
            </div>
            <div>
              <dt>支持语言</dt>
              <dd>{m.languages?.join(" / ") ?? "—"}</dd>
            </div>
            <div>
              <dt>官网 Telegram 入口</dt>
              <dd>→ Primary Bot（本轮不开发官网）</dd>
            </div>
          </dl>
        )}
        {t === "Telegram" && (
          <TelegramResources
            p={{ ...p, scope: { ...p.scope, market: code, platform: "" } }}
            embedded
          />
        )}
        {t === "Platforms" && (
          <PlatformTable
            p={p}
            rows={p.data.platforms.filter((x) => x.market === code)}
            open={() => p.onTab("Platform")}
          />
        )}
        {t === "高级设置" && (
          <details className="ops-details" open>
            <summary>高级设置 · 仅管理员</summary>
            <p className="ops-muted small">
              Market 与现有 Brand
              的正式关系待后端确认（ARCHITECTURE_CONFIRMATION_REQUIRED）。Code
              一旦产生历史不应轻易修改。
            </p>
            <dl className="ops-dl">
              <div>
                <dt>Market Code</dt>
                <dd>
                  <code>{m.code}</code>
                </dd>
              </div>
            </dl>
          </details>
        )}
      </section>
    </div>
  );
}

// ───────────── Telegram 资源 ─────────────
function ResourceForm({
  kind,
  market,
  onSave,
  onClose,
}: {
  kind: TgKind;
  market: Market;
  onSave: (r: TgResource) => void;
  onClose: () => void;
}) {
  const [f, setF] = useState({
    name: "",
    handle: "",
    primary: false,
    status: "configured" as TgResource["status"],
  });
  return (
    <div
      className="ops-modal"
      role="dialog"
      aria-label={`新增 ${tgKindText[kind]}`}
    >
      <div className="mk-form">
        <h3>新增 {tgKindText[kind]}</h3>
        <p className="mk-final">
          所属 Market：<b>{marketLabel(market)}</b>
        </p>
        <label>
          {tgKindText[kind]} 显示名称
          <input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
        </label>
        <label>
          {kind === "bot" ? "Username" : `Telegram ${tgKindText[kind]}`}
          <input
            value={f.handle}
            onChange={(e) => setF({ ...f, handle: e.target.value })}
            placeholder="@username"
          />
        </label>
        <label className="mk-check">
          <input
            type="checkbox"
            checked={f.primary}
            onChange={(e) => setF({ ...f, primary: e.target.checked })}
          />{" "}
          设为 Primary
        </label>
        {kind === "bot" && (
          <p className="mk-note">
            Bot Token/Secret
            不在此处填写：安全配置为独立步骤（BACKEND_PENDING），前端不保存
            Token。
          </p>
        )}
        <div className="mk-actions">
          <button className="ops-ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="ops-primary"
            disabled={!f.name.trim() || !f.handle.trim()}
            onClick={() => {
              onSave({
                id: `${kind}-${Date.now()}`,
                kind,
                market: market.code,
                name: f.name,
                handle: f.handle,
                primary: false,
                status: f.status,
                secret: kind === "bot" ? "missing" : undefined,
              });
              onClose();
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

export function TelegramResources({
  p,
  embedded,
}: {
  p: SettingsProps;
  embedded?: boolean;
}) {
  const { data, onData, canEdit, preview, scope } = p;
  const market = data.markets.find((m) => m.code === scope.market);
  const [add, setAdd] = useState<TgKind | null>(null);
  const [prim, setPrim] = useState<TgResource | null>(null);
  const [dis, setDis] = useState<TgResource | null>(null);
  const editable = !!onData && canEdit;
  if (!market) return <p className="ops-empty">请先选择国家/市场</p>;
  const rs = data.resources.filter((r) => r.market === market.code);
  const section = (kind: TgKind) => {
    const list = rs.filter((r) => r.kind === kind && r.status !== "archived");
    return (
      <section key={kind} className="mk-res">
        <div className="ops-panel-head">
          <h3>
            {tgKindText[kind]}s{" "}
            <small className="ops-muted">{list.length}</small>
          </h3>
          {editable && (
            <button className="ops-ghost" onClick={() => setAdd(kind)}>
              + 新增 {tgKindText[kind]}
            </button>
          )}
        </div>
        {!list.length ? (
          <p className="ops-muted small">尚未配置 {tgKindText[kind]}</p>
        ) : (
          <ul className="mk-res-list">
            {[...list]
              .sort((a, b) => Number(b.primary) - Number(a.primary))
              .map((r) => (
                <li key={r.id} className={r.primary ? "is-primary" : ""}>
                  <span className="mk-tg" aria-hidden>
                    {kind === "bot" ? "B" : kind === "channel" ? "C" : "G"}
                  </span>
                  <div>
                    <b>
                      {r.name}
                      {r.primary && <em className="mk-primary">Primary</em>}
                    </b>
                    <small>
                      {r.handle}
                      {r.purpose ? ` · ${r.purpose}` : ""}
                    </small>
                  </div>
                  <StatusPill s={r.status} text={tgStatusText[r.status]} />
                  {kind === "bot" && (
                    <span className="ops-muted small">
                      {r.secret === "configured"
                        ? "Secret 已安全配置"
                        : r.secret === "missing"
                          ? "Secret 未配置"
                          : "Secret 状态待接入"}
                    </span>
                  )}
                  {editable && (
                    <span className="mk-row-actions">
                      {!r.primary && r.status !== "disabled" && (
                        <button className="ops-link" onClick={() => setPrim(r)}>
                          设为 Primary
                        </button>
                      )}
                      {r.status !== "disabled" && (
                        <button className="ops-link" onClick={() => setDis(r)}>
                          停用
                        </button>
                      )}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        )}
      </section>
    );
  };
  const old = prim && rs.find((r) => r.kind === prim.kind && r.primary);
  return (
    <div className={embedded ? "" : "ops"}>
      <div className={embedded ? "" : "ops-panel"}>
        {!embedded && (
          <div className="ops-panel-head">
            <h2>Telegram 资源 · {marketLabel(market)}</h2>
          </div>
        )}
        <WriteNote preview={preview && editable} />
        <div className="mk-res-grid">
          {(["bot", "channel", "group"] as TgKind[]).map(section)}
        </div>
      </div>
      <BotHomePreview data={data} market={market.code} />
      {add && (
        <ResourceForm
          kind={add}
          market={market}
          onClose={() => setAdd(null)}
          onSave={(r) =>
            onData!({ ...data, resources: [...data.resources, r] })
          }
        />
      )}
      {prim && (
        <Confirm
          title={`切换 Primary ${tgKindText[prim.kind]}`}
          lines={[
            <>
              旧 Primary：<b>{old?.name ?? "无"}</b>
            </>,
            <>
              新 Primary：<b>{prim.name}</b>
            </>,
            "普通用户默认入口将随之改变。",
          ]}
          onOk={() =>
            onData!({ ...data, resources: setPrimary(data.resources, prim.id) })
          }
          onClose={() => setPrim(null)}
        />
      )}
      {dis &&
        (disableBlock(dis) ? (
          <Confirm
            title={`无法停用 ${dis.name}`}
            lines={[disableBlock(dis)!]}
            onClose={() => setDis(null)}
          />
        ) : (
          <Confirm
            title={`停用 ${dis.name}`}
            danger
            lines={[
              "停用后不再作为新入口或发布目标；历史用户、发布记录与审计仍保留。",
            ]}
            okText="停用"
            onOk={() =>
              onData!({
                ...data,
                resources: data.resources.map((x) =>
                  x.id === dis.id ? { ...x, status: "disabled" } : x,
                ),
              })
            }
            onClose={() => setDis(null)}
          />
        ))}
    </div>
  );
}

/** Product preview of the /start screen. Not a real Telegram message; never calls Telegram. */
export function BotHomePreview({
  data,
  market,
  bot,
}: {
  data: SettingsData;
  market: string;
  bot?: string;
}) {
  const m = data.markets.find((x) => x.code === market);
  const bots = data.resources.filter(
    (r) =>
      r.market === market &&
      r.kind === "bot" &&
      r.status !== "disabled" &&
      r.status !== "archived",
  );
  const b =
    bots.find((x) => x.id === bot) ?? bots.find((x) => x.primary) ?? bots[0];
  const buttons = botHomeButtons(data.resources, market);
  return (
    <section className="ops-panel mk-bothome" aria-label="Bot Home Preview">
      <div className="ops-panel-head">
        <h2>Bot Home 预览</h2>
        <span className="ops-badge pending">产品 Preview · 非真实 Bot</span>
      </div>
      <div className="mk-chat">
        <div className="mk-chat-top">
          <i aria-hidden>{(b?.name ?? "?").slice(0, 1)}</i>
          <b>{b?.name ?? "未配置 Bot"}</b>
          <small>{b?.handle}</small>
        </div>
        <div className="mk-bubble">
          <p>
            <b>欢迎来到 {m?.localName ?? m?.name ?? market}</b>
          </p>
          <p>查看会员等级、奖励和活动，也可以加入官方社区获取最新消息。</p>
        </div>
        <div className="mk-kb">
          {buttons.map((x) => (
            <button
              key={x.key}
              className={x.key === "mini" ? "main" : ""}
              title={`打开：${x.target}`}
            >
              {x.label}
            </button>
          ))}
        </div>
        <p className="mk-chat-foot">
          {buttons.map((x) => `${x.label} → ${x.target}`).join(" · ")}
        </p>
      </div>
    </section>
  );
}

// ───────────── Platform ─────────────
function PlatformForm({
  market,
  onSave,
  onClose,
}: {
  market: Market;
  onSave: (p: Platform) => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<Platform>({
    code: "",
    name: "",
    market: market.code,
    currency: market.currency,
    timezone: market.timezone,
    status: "draft",
    dataStatus: "none",
  });
  const ok = /^[A-Z0-9_]{2,16}$/.test(f.code) && f.name.trim();
  return (
    <div className="ops-modal" role="dialog" aria-label="新增 Platform">
      <div className="mk-form">
        <h3>新增 Platform</h3>
        <p className="mk-final">
          所属 Market：<b>{marketLabel(market)}</b>（来自当前范围）
        </p>
        <label>
          Platform 名称
          <input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
        </label>
        <label>
          Platform Code
          <input
            value={f.code}
            onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })}
          />
          <small>唯一性由后端校验</small>
        </label>
        <label>
          Currency
          <select
            value={f.currency}
            onChange={(e) => setF({ ...f, currency: e.target.value })}
          >
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Timezone
          <select
            value={f.timezone}
            onChange={(e) => setF({ ...f, timezone: e.target.value })}
          >
            {timezones.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <p className="ops-muted small">
          创建后为「草稿」。数据接入（Adapter /
          Mapping）单独配置并验证后才能启用。
        </p>
        <div className="mk-actions">
          <button className="ops-ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="ops-primary"
            disabled={!ok}
            onClick={() => {
              onSave(f);
              onClose();
            }}
          >
            创建草稿
          </button>
        </div>
      </div>
    </div>
  );
}
function PlatformTable({
  p,
  rows,
  open,
}: {
  p: SettingsProps;
  rows: Platform[];
  open: (code: string) => void;
}) {
  const mk = (c: string) => p.data.markets.find((m) => m.code === c);
  return (
    <div className="ops-scroll">
      <table className="ops-table mk-table">
        <thead>
          <tr>
            <th>Platform</th>
            <th>Market</th>
            <th>Currency</th>
            <th className="mk-hide-md">Timezone</th>
            <th>状态</th>
            <th>数据接入</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.market + x.code}>
              <td>
                <span className="mk-logo" aria-hidden>
                  {x.name.slice(0, 2)}
                </span>
                <b>{x.name}</b>
              </td>
              <td>{mk(x.market)?.name ?? x.market}</td>
              <td>{x.currency}</td>
              <td className="mk-hide-md">{x.timezone}</td>
              <td>
                <StatusPill s={x.status} text={lifeText[x.status]} />
              </td>
              <td>
                <StatusPill
                  s={`d-${x.dataStatus}`}
                  text={dataStatusText[x.dataStatus]}
                />
              </td>
              <td>
                <button className="ops-link" onClick={() => open(x.code)}>
                  查看
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function PlatformList({
  p,
  open,
}: {
  p: SettingsProps;
  open: (code: string) => void;
}) {
  const { data, scope, onData, canEdit, preview } = p;
  const market = data.markets.find((m) => m.code === scope.market);
  const [add, setAdd] = useState(false);
  const editable = !!onData && canEdit && !!market;
  return (
    <Panel
      title={`Platform · ${market ? marketLabel(market) : "全部"}`}
      extra={
        editable && (
          <button className="ops-primary" onClick={() => setAdd(true)}>
            + 新增 Platform
          </button>
        )
      }
    >
      <WriteNote preview={preview && editable} />
      <Searchable
        rows={data.platforms.filter((x) => !market || x.market === market.code)}
        keyOf={(x) => x.code}
        text={(x) => x.name + x.code}
        statusOf={(x) => x.status}
        placeholder="搜索 Platform"
      >
        {(rows) => <PlatformTable p={p} rows={rows} open={open} />}
      </Searchable>
      {add && market && (
        <PlatformForm
          market={market}
          onClose={() => setAdd(false)}
          onSave={(x) =>
            onData!({ ...data, platforms: [...data.platforms, x] })
          }
        />
      )}
    </Panel>
  );
}
const platformTabs = [
  "基本信息",
  "用户绑定",
  "数据接入",
  "Growth规则",
  "兑换码库存",
  "高级详情",
] as const;
function PlatformDetail({
  p,
  code,
  back,
}: {
  p: SettingsProps;
  code: string;
  back: () => void;
}) {
  const x =
    p.data.platforms.find(
      (y) => y.code === code && y.market === p.scope.market,
    ) ?? p.data.platforms.find((y) => y.code === code);
  const [t, setT] = useState<(typeof platformTabs)[number]>("基本信息");
  const [act, setAct] = useState<LifeStatus | null>(null);
  if (!x) return null;
  const m = p.data.markets.find((y) => y.code === x.market);
  const editable = !!p.onData && p.canEdit;
  const canActivate = x.dataStatus === "ready";
  return (
    <div className="ops">
      <button className="ops-ghost" onClick={back}>
        ← 返回 Platform 列表
      </button>
      <section className="ops-panel">
        <div className="mk-detail-head">
          <span className="mk-logo big" aria-hidden>
            {x.name.slice(0, 2)}
          </span>
          <h2>{x.name}</h2>
          <StatusPill s={x.status} text={lifeText[x.status]} />
          <span className="ops-muted">{m ? marketLabel(m) : x.market}</span>
          {editable && (
            <span className="mk-row-actions">
              {x.status === "draft" && (
                <button
                  className="ops-primary"
                  onClick={() => setAct("active")}
                >
                  启用
                </button>
              )}
              {x.status === "active" && (
                <button className="ops-link" onClick={() => setAct("disabled")}>
                  停用
                </button>
              )}
              {x.status !== "archived" && (
                <button className="ops-link" onClick={() => setAct("archived")}>
                  归档
                </button>
              )}
            </span>
          )}
        </div>
        <Tabs
          items={platformTabs}
          value={t}
          onChange={setT}
          label="Platform 详情"
        />
        {t === "基本信息" && (
          <dl className="ops-dl">
            <div>
              <dt>Platform Code</dt>
              <dd>{x.code}</dd>
            </div>
            <div>
              <dt>所属 Market</dt>
              <dd>{m ? marketLabel(m) : x.market}</dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd>{x.currency}</dd>
            </div>
            <div>
              <dt>Timezone</dt>
              <dd>{x.timezone}</dd>
            </div>
            <div>
              <dt>Platform 状态</dt>
              <dd>{lifeText[x.status]}</dd>
            </div>
            <div>
              <dt>数据接入</dt>
              <dd>
                {dataStatusText[x.dataStatus]}
                {x.dataStatus !== "ready" && "（创建 Platform ≠ 数据可用）"}
              </dd>
            </div>
          </dl>
        )}
        {t === "用户绑定" && (
          <p className="ops-pending-note">
            关联会员与绑定状态统计待接入（按 Identity：已绑定 / 审核中 /
            需要重新处理）。
          </p>
        )}
        {t === "数据接入" && <DataIntegration p={p} platform={x} />}
        {t === "Growth规则" && (
          <p className="ops-muted">
            该 Platform 作为 Growth 来源；Growth 余额属于 {m?.name ?? x.market}{" "}
            会员体系，不按 Platform 拆分。规则见「会员 → Growth 规则」。
          </p>
        )}
        {t === "兑换码库存" && (
          <Inventory
            rewards={p.data.rewards}
            market={x.market}
            platform={x.code}
            platformName={x.name}
            preview={p.preview}
          />
        )}
        {t === "高级详情" && (
          <details className="ops-details">
            <summary>高级详情 · 仅管理员</summary>
            <p className="ops-muted small">
              Adapter、Mapping Version、Canonical Field
              Definition、Fingerprint、Approval
              仅高级管理员查看（BACKEND_PENDING）。
            </p>
          </details>
        )}
      </section>
      {act &&
        (act === "active" && !canActivate ? (
          <Confirm
            title="暂不能启用"
            lines={[
              "启用前需完成数据接入验证（Adapter / Mapping）。",
              "启用前检查结果由后端返回（BACKEND_PENDING）。",
            ]}
            onClose={() => setAct(null)}
          />
        ) : (
          <Confirm
            title={`${lifeText[act]} ${x.name}`}
            danger={act !== "active"}
            lines={[
              act === "active"
                ? "启用后出现在该市场的绑定、活动与兑换目标中。"
                : "停用/归档后不出现在新绑定、普通活动与兑换目标中；历史记录仍显示。",
            ]}
            onOk={() =>
              p.onData!({
                ...p.data,
                platforms: p.data.platforms.map((y) =>
                  y === x ? { ...y, status: act } : y,
                ),
              })
            }
            onClose={() => setAct(null)}
          />
        ))}
    </div>
  );
}

// ───────────── 数据接入 ─────────────
// Raw → Adapter → Mapping → Canonical → Metrics is a backend pipeline. Operators
// only pick Market / Platform and upload the Platform's original export file.
export function Capability({ platform }: { platform: Platform }) {
  const c = platform.capabilities;
  return (
    <section className="mk-cap" aria-label={`${platform.name} 数据能力`}>
      <h4>数据能力 · {platform.name}</h4>
      {!c ? (
        <p className="ops-muted small">
          数据能力待接入（后端 Platform Data Capability）
        </p>
      ) : (
        <ul>
          {capKeys.map((k) => {
            const st = c[k] ?? "pending";
            return (
              <li key={k}>
                <span>{capText[k]}</span>
                <StatusPill s={`c-${st}`} text={capStateText[st]} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
function Datasets({ row, platform }: { row?: ImportRow; platform?: Platform }) {
  const need = platform?.requiredDatasets;
  if (!need) return <span className="ops-muted">待接入</span>;
  return (
    <span className="mk-ds">
      {need.map((d) => {
        const ok = row?.datasets?.[d];
        return (
          <span key={d} className={ok ? "ok" : "miss"}>
            {datasetText[d] ?? d} {ok ? "✓" : "✕"}
          </span>
        );
      })}
    </span>
  );
}
function DataIntegration({
  p,
  platform,
}: {
  p: SettingsProps;
  platform?: Platform;
}) {
  const rows = p.data.imports.filter(
    (r) =>
      r.market === p.scope.market &&
      (!platform || r.platform === platform.code),
  );
  const [upload, setUpload] = useState<string | null>(null);
  const [picked, setPicked] = useState(false);
  const plat = (c: string) =>
    p.data.platforms.find((x) => x.code === c && x.market === p.scope.market);
  const pName = (c: string) => plat(c)?.name ?? c;
  const active = platform
    ? [platform]
    : marketPlatforms(p.data.platforms, p.scope.market);
  const up = upload ? (plat(upload) ?? platform) : undefined;
  // Only the latest business day's record decides the format-change state; an older flagged day must not block today's upload.
  const latest = up
    ? rows
        .filter((r) => r.platform === up.code)
        .sort((a, b) => b.day.localeCompare(a.day))[0]
    : undefined;
  const changed = Boolean(latest?.formatChanged);
  return (
    <div className="mk-import">
      <div className="ops-panel-head">
        <h3>今日数据状态</h3>
        <button
          className="ops-primary"
          onClick={() => {
            setUpload(platform?.code ?? p.scope.platform);
            setPicked(false);
          }}
        >
          上传数据
        </button>
      </div>
      <p className="ops-muted small">
        上传 Platform 原始导出文件即可，无需改列名、删列、换算金额或整理
        Excel；系统负责识别、解析、清洗与标准化。
      </p>
      {!rows.length ? (
        <p className="ops-empty">当前范围暂无导入记录</p>
      ) : (
        <div className="ops-scroll">
          <table className="ops-table mk-table">
            <thead>
              <tr>
                <th>Platform</th>
                <th>业务日期</th>
                <th>状态</th>
                <th>完整性</th>
                <th>所需数据</th>
                <th>数据量</th>
                <th className="mk-hide-md">更新时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <b>{pName(r.platform)}</b>
                  </td>
                  <td>{r.day}</td>
                  <td>
                    <StatusPill
                      s={`i-${r.status}`}
                      text={importText[r.status]}
                    />
                  </td>
                  <td>
                    {r.completeness ? (
                      <StatusPill
                        s={`k-${r.completeness}`}
                        text={completenessText[r.completeness]}
                      />
                    ) : (
                      <span className="ops-muted">待接入</span>
                    )}
                  </td>
                  <td>
                    <Datasets row={r} platform={plat(r.platform)} />
                  </td>
                  <td>{r.rows ?? "—"}</td>
                  <td className="mk-hide-md">{r.updatedAt ?? "—"}</td>
                  <td>
                    {r.formatChanged && (
                      <span className="mk-warn">
                        数据格式发生变化，需要管理员处理
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mk-cap-grid">
        {active.map((x) => (
          <Capability key={x.code} platform={x} />
        ))}
      </div>
      <details className="ops-details">
        <summary>高级数据接入 · 仅管理员</summary>
        <p className="ops-muted small">
          数据链路：原始文件 → Platform Adapter → 解析/清洗 → Mapping → 标准数据
          → 校验/完整性 → 后端指标。Dashboard 只读取标准数据，不依赖任何
          Platform 的 Excel 列名。
        </p>
        <div className="ops-scroll">
          <table className="ops-table mk-table">
            <thead>
              <tr>
                <th>Platform</th>
                <th>接入状态</th>
                <th>Mapping 版本</th>
                <th>Mapping 状态</th>
                <th>最后验证</th>
              </tr>
            </thead>
            <tbody>
              {active.map((x) => (
                <tr key={x.code}>
                  <td>{x.name}</td>
                  <td>
                    <StatusPill
                      s={`d-${x.dataStatus}`}
                      text={dataStatusText[x.dataStatus]}
                    />
                  </td>
                  <td>{x.mapping?.version ?? "待接入"}</td>
                  <td>{x.mapping?.status ?? "待接入"}</td>
                  <td>{x.mapping?.verifiedAt ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="ops-muted small">
          Mapping
          版本化、原始文件可追溯、修正后从原始数据重算，均由后端负责（BACKEND_PENDING）。
        </p>
      </details>
      {upload !== null && (
        <div className="ops-modal" role="dialog" aria-label="上传平台数据">
          <div className="mk-form">
            <h3>上传平台数据</h3>
            <p className="mk-final">
              Market：
              <b>
                {p.data.markets.find((m) => m.code === p.scope.market)?.name ??
                  "—"}
              </b>
            </p>
            {!platform && (
              <label>
                Platform
                <select
                  aria-label="上传 Platform"
                  value={upload}
                  onChange={(e) => setUpload(e.target.value)}
                >
                  <option value="">请选择</option>
                  {active.map((x) => (
                    <option key={x.code} value={x.code}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              原始文件（CSV / XLSX）
              <input
                type="file"
                accept=".csv,.xlsx"
                onChange={() => setPicked(true)}
              />
            </label>
            {p.preview && up && (
              <>
                {!picked && (
                  <button className="ops-ghost" onClick={() => setPicked(true)}>
                    模拟选择文件（PREVIEW）
                  </button>
                )}
                {picked &&
                  (changed ? (
                    <p className="mk-warn" role="alert">
                      数据格式发生变化，需要管理员处理。系统已停止自动导入（缺少原字段
                      / 出现未知字段）。
                    </p>
                  ) : (
                    <dl className="ops-dl" aria-label="上传预检（模拟）">
                      <div>
                        <dt>文件</dt>
                        <dd>{up.code.toLowerCase()}_raw_export.xlsx</dd>
                      </div>
                      <div>
                        <dt>识别 Platform</dt>
                        <dd>{up.name}</dd>
                      </div>
                      <div>
                        <dt>业务日期</dt>
                        <dd>2026-09-29</dd>
                      </div>
                      <div>
                        <dt>原始行数</dt>
                        <dd>12,902</dd>
                      </div>
                      <div>
                        <dt>有效行数</dt>
                        <dd>12,880</dd>
                      </div>
                      <div>
                        <dt>待确认</dt>
                        <dd>22</dd>
                      </div>
                      <div>
                        <dt>完整性</dt>
                        <dd>
                          {up.requiredDatasets
                            ?.map((d) => datasetText[d] ?? d)
                            .join(" / ")}{" "}
                          ·{" "}
                          {Object.values(up.capabilities ?? {}).some(
                            (c) => c !== "available",
                          )
                            ? "部分缺失（部分数据待接入）"
                            : "完整"}
                        </dd>
                      </div>
                    </dl>
                  ))}
              </>
            )}
            <p className="mk-note">
              解析、Mapping、标准化与完整性校验由后端承担（BACKEND_PENDING），浏览器不解析正式报表。
              {p.preview ? " 以上为 PREVIEW 模拟。" : ""}
            </p>
            <div className="mk-actions">
              <button className="ops-ghost" onClick={() => setUpload(null)}>
                关闭
              </button>
              <button className="ops-primary" disabled>
                确认导入（待接入）
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────── 入口 ─────────────
export default function Settings(p: SettingsProps) {
  const [market, setMarket] = useState<string | null>(null);
  const [plat, setPlat] = useState<string | null>(null);
  const tab = p.tab;
  const go = (t: SettingsTab) => {
    setMarket(null);
    setPlat(null);
    p.onTab(t);
  };
  return (
    <div className="ops">
      <Tabs items={settingsTabs} value={tab} onChange={go} label="设置模块" />
      {!p.canEdit && (
        <p className="ops-info" role="status">
          你没有高级配置权限：以下为只读信息。
        </p>
      )}
      {tab === "国家与市场" &&
        (market ? (
          <MarketDetail p={p} code={market} back={() => setMarket(null)} />
        ) : (
          <MarketList
            p={p}
            open={(c) => {
              p.onScope({ market: c, platform: "" });
              setMarket(c);
            }}
          />
        ))}
      {tab === "Telegram资源" && <TelegramResources p={p} />}
      {tab === "Platform" &&
        (plat ? (
          <PlatformDetail p={p} code={plat} back={() => setPlat(null)} />
        ) : (
          <PlatformList p={p} open={setPlat} />
        ))}
      {tab === "数据接入" && (
        <section className="ops-panel">
          <DataIntegration p={p} />
        </section>
      )}
      {tab === "语言" && (
        <Panel title="语言">
          <p className="ops-muted">
            后台语言：简体中文。用户端语言沿用现有 i18n（{languages.join(" / ")}
            ），每个 Market 设置默认语言与支持语言，不复制翻译文件。
          </p>
          <dl className="ops-dl">
            {p.data.markets
              .filter((m) => m.status !== "archived")
              .map((m) => (
                <div key={m.code}>
                  <dt>{marketLabel(m)}</dt>
                  <dd>
                    默认 {m.defaultLanguage ?? "—"} · 支持{" "}
                    {m.languages?.join(" / ") ?? "—"}
                  </dd>
                </div>
              ))}
          </dl>
        </Panel>
      )}
      {tab === "高级设置" && (
        <Panel title="高级设置 · 仅管理员">
          <p className="ops-muted">
            Brand 技术
            Scope、Mapping、Audit、系统诊断保留在正式后台高级入口。Market 与
            Brand 的正式关系待后端确认，前端不作结论。
          </p>
        </Panel>
      )}
    </div>
  );
}
