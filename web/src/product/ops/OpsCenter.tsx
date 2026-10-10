import { useState, type ReactNode } from "react";
import {
  coreMeta,
  fmt,
  share,
  primaryKeys,
  secondaryKeys,
  trendKeys,
  trendSeries,
  periodDays,
  trendDays,
  periodLabel,
  type Cell,
  type OpsData,
  type Period,
  type Scope,
  type TrendKey,
} from "./model";
import { PerfBlock, PerfPage } from "./PrivatePerf";
import "./ops.css";
import "./market.css";

export const dataDomains = [
  "私域成效",
  "会员",
  "Growth",
  "Points",
  "裂变",
  "留存",
] as const;
export type DataDomain = (typeof dataDomains)[number];

export type OpsCenterProps = {
  data: OpsData | null;
  loading?: boolean;
  error?: string | null;
  scope: Scope;
  onScope: (s: Scope) => void;
  platforms: { id: string; display_name: string; market: string }[];
  /** Brand/Bot are technical scopes: shown only as small context text, never as a business selector. */
  scopeLabel?: { brand: string; bot: string };
  /** Market options from configuration. Missing = derive from real platforms. */
  markets?: { code: string; name: string }[];
  mode: "overview" | "data";
  /** Targets: pending item targets, "data:<DataDomain>" for analysis links. */
  onNavigate?: (target: string) => void;
  onRefresh?: () => void;
  domain?: DataDomain;
  onDomain?: (d: DataDomain) => void;
};

export function Tip({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <span
      className="ops-tip"
      tabIndex={0}
      role="note"
      aria-label={text}
      data-tip={text}
    >
      ?
    </span>
  );
}
export function Value({ cell, big }: { cell: Cell; big?: boolean }) {
  return (
    <strong className={`ops-value ops-${cell.s}${big ? " big" : ""}`}>
      {fmt(cell)}
    </strong>
  );
}
function Stat({
  label,
  cell,
  tip,
  note,
}: {
  label: string;
  cell: Cell;
  tip?: string;
  note?: string;
}) {
  return (
    <div className="ops-stat">
      <span>
        {label}
        <Tip text={tip} />
      </span>
      <Value cell={cell} />
      {note && <small>{note}</small>}
    </div>
  );
}
function Section({
  title,
  extra,
  children,
  id,
  className = "",
}: {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section className={`ops-panel ${className}`} aria-labelledby={id}>
      <div className="ops-panel-head">
        <h2 id={id}>{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  );
}
function PendingNote({
  text = "待接入",
  why,
}: {
  text?: string;
  why?: string;
}) {
  return (
    <p className="ops-pending-note">
      {text}
      {why && <small>{why}</small>}
    </p>
  );
}
function More({
  to,
  label,
  onNavigate,
}: {
  to: string;
  label: string;
  onNavigate?: (t: string) => void;
}) {
  if (!onNavigate) return null;
  return (
    <button className="ops-link" onClick={() => onNavigate(to)}>
      {label} →
    </button>
  );
}

export function FilterBar({
  scope,
  onScope,
  platforms,
  markets,
  onRefresh,
}: Pick<
  OpsCenterProps,
  "scope" | "onScope" | "platforms" | "markets" | "onRefresh"
>) {
  const set = (p: Partial<Scope>) => onScope({ ...scope, ...p });
  // Market list comes from config (or the markets of real platforms); never hard-coded.
  const ms =
    markets ??
    [...new Set(platforms.map((p) => p.market))].map((m) => ({
      code: m,
      name: m,
    }));
  const mName = ms.find((m) => m.code === scope.market)?.name;
  const pName = platforms.find((p) => p.id === scope.platform)?.display_name;
  return (
    <div className="ops-filter" role="group" aria-label="统计范围">
      <span className="mk-scope-now" aria-live="polite">
        当前：{mName ?? (scope.market || "全部国家")} /{" "}
        {pName ?? "全部 Platform"}
      </span>
      <select
        aria-label="报表市场"
        value={scope.market}
        onChange={(e) =>
          onScope({ ...scope, market: e.target.value, platform: "" })
        }
      >
        {!markets && <option value="">全部市场</option>}
        {ms.map((m) => (
          <option key={m.code} value={m.code}>
            {m.name === m.code ? m.code : `${m.name} (${m.code})`}
          </option>
        ))}
      </select>
      <select
        aria-label="报表平台"
        value={scope.platform}
        onChange={(e) => set({ platform: e.target.value })}
      >
        <option value="">全部 Platform</option>
        {platforms
          .filter((p) => !scope.market || p.market === scope.market)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.display_name}
            </option>
          ))}
      </select>
      <input
        aria-label="业务日期"
        type="date"
        value={scope.day}
        onChange={(e) => e.target.value && set({ day: e.target.value })}
      />
      <div className="ops-seg" aria-label="统计周期">
        {(["day", "week", "month"] as Period[]).map((p) => (
          <button
            key={p}
            aria-pressed={scope.period === p}
            onClick={() => set({ period: p })}
          >
            {periodLabel[p]}
          </button>
        ))}
      </div>
      {onRefresh && (
        <button className="ops-ghost" onClick={onRefresh}>
          刷新
        </button>
      )}
    </div>
  );
}

function Context({
  data,
  scope,
  tech,
}: {
  data: OpsData | null;
  scope: Scope;
  tech?: { brand: string; bot: string };
}) {
  let range = "";
  try {
    const d = periodDays(scope.day, scope.period);
    range = d.start === d.end ? d.start : `${d.start} → ${d.end}`;
  } catch {
    range = "日期无效";
  }
  const label =
    scope.period === "day"
      ? "业务日"
      : scope.period === "week"
        ? "周一至周日"
        : "自然月";
  return (
    <p className="ops-context">
      {data?.preview && <b className="ops-preview-tag">PREVIEW 模拟数据</b>}
      <span>
        {label} · {range}
      </span>
      <span>业务时区 {data?.timezone ?? "读取中"}</span>
      <span>
        {data?.realtime
          ? "实时"
          : data?.updatedAt
            ? `最后更新 ${data.updatedAt.replace("T", " ").slice(0, 16)}`
            : "更新时间未知"}
      </span>
      {tech && (
        <span title="技术范围（Brand / Bot），非业务筛选">
          技术范围 {tech.brand} · {tech.bot}
        </span>
      )}
    </p>
  );
}

function Delta({ v }: { v?: string }) {
  if (!v) return null;
  const down = v.trim().startsWith("-");
  return (
    <em
      className={`ops-delta ${down ? "down" : "up"}`}
      title="较上一周期（后端提供）"
    >
      {down ? "↓" : "↑"} {v.replace(/^[+-]/, "")}
    </em>
  );
}
export function CoreGrid({
  data,
  platformName,
}: {
  data: OpsData;
  platformName?: string;
}) {
  const name = (
    k: (typeof primaryKeys)[number] | (typeof secondaryKeys)[number],
  ) =>
    platformName && k === "members"
      ? `${platformName} 关联会员`
      : coreMeta[k].name;
  return (
    <>
      <div className="ops-core" aria-label="核心指标">
        {primaryKeys.map((k) => {
          const c = data.metrics[k];
          return (
            <article key={k} className={`ops-card ops-card-${c.s}`}>
              <span>
                {name(k)}
                <Tip
                  text={
                    platformName && c.s === "na"
                      ? "该指标不支持 Platform 范围"
                      : platformName && k === "members"
                        ? `与 ${platformName} 存在有效关联的会员数（不是整个市场会员总数）`
                        : coreMeta[k].tip
                  }
                />
              </span>
              <Value cell={c} big />
              {c.s === "na" && <small className="ops-muted">不适用</small>}
              <Delta v={data.deltas?.[k]} />
            </article>
          );
        })}
      </div>
      <div className="ops-secondary" aria-label="辅助指标">
        {secondaryKeys.map((k) => (
          <span key={k}>
            {name(k)}
            <Tip text={coreMeta[k].tip} />
            <Value cell={data.metrics[k]} />
          </span>
        ))}
      </div>
    </>
  );
}

function PendingCenter({
  data,
  onNavigate,
}: {
  data: OpsData;
  onNavigate?: (t: string) => void;
}) {
  const items = data.pending;
  const gaps = data.pendingGaps ?? [];
  const gapText = {
    forbidden: "无权限",
    pending: "待接入",
    incomplete: "数据不完整",
  } as const;
  return (
    <Section
      title="待处理"
      id="ops-pending"
      className="ops-pending-panel"
      extra={
        items &&
        items.length > 0 && <span className="ops-count">{items.length} 类</span>
      }
    >
      {data.pendingFailure ? (
        <p className="ops-empty" role="alert">
          {data.pendingFailure === "forbidden"
            ? "无权查看待处理汇总"
            : "待处理加载失败，请刷新重试"}
        </p>
      ) : items === null ? (
        <PendingNote text="待处理聚合待接入：后端尚未提供跨模块待办数量" />
      ) : !items.length && !gaps.length ? (
        <p className="ops-empty ok">当前无待处理事项</p>
      ) : !items.length ? (
        <p className="ops-empty">可查看的类别暂无待处理</p>
      ) : (
        <ul className="ops-todo">
          {[...items]
            .sort((a, b) =>
              a.severity === b.severity
                ? 0
                : a.severity === "critical"
                  ? -1
                  : 1,
            )
            .map((i) => (
              <li key={i.key} className={i.severity}>
                <div>
                  <b>
                    {i.severity === "critical" && (
                      <span className="ops-sev">严重</span>
                    )}
                    {i.label}
                  </b>
                  <small>{i.reason}</small>
                </div>
                <strong>{fmt({ s: "value", v: i.count })}</strong>
                {onNavigate ? (
                  <button onClick={() => onNavigate(i.target)}>去处理</button>
                ) : (
                  <button disabled title="当前没有可用的处理入口">
                    暂无入口
                  </button>
                )}
              </li>
            ))}
        </ul>
      )}
      {data.pendingScopeNote && (
        <p className="ops-muted small" role="note">
          {data.pendingScopeNote}
        </p>
      )}
      {!data.pendingFailure && gaps.length > 0 && (
        <p className="ops-muted small" aria-label="未计入的待处理类别">
          未计入：
          {gaps.map((g) => `${g.label}（${gapText[g.state]}）`).join("、")}
        </p>
      )}
    </Section>
  );
}

function AreaChart({
  rows,
  cols,
}: {
  rows: { date: string; values: Cell[] }[];
  cols: string[];
}) {
  const W = 600,
    H = 160,
    pad = 8;
  const nums = rows.flatMap((r) =>
    r.values.map((v) => (v.s === "value" ? Number(v.v) : 0)),
  );
  const max = Math.max(1, ...nums);
  const x = (i: number) =>
    rows.length === 1 ? W / 2 : (i / (rows.length - 1)) * W;
  const y = (n: number) => H - pad - (n / max) * (H - pad * 2);
  const every = Math.ceil(rows.length / 8);
  return (
    <div className="ops-area">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${cols.join("/")}趋势图`}
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1="0" x2={W} y1={H * g} y2={H * g} className="grid" />
        ))}
        {cols.map((_, ci) => {
          const pts = rows.map((r, i) => {
            const v = r.values[ci];
            return [x(i), y(v?.s === "value" ? Number(v.v) : 0)] as const;
          });
          const line = pts
            .map(([a, b], i) => `${i ? "L" : "M"}${a},${b}`)
            .join(" ");
          return (
            <g key={ci} className={`s${ci}`}>
              {ci === 0 && (
                <path d={`${line} L${W},${H} L0,${H} Z`} className="fill" />
              )}
              <path
                d={line}
                className="line"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
      </svg>
      <div className="ops-area-x">
        {rows.map((r, i) => (
          <small key={r.date}>
            {i % every === 0 || i === rows.length - 1 ? r.date.slice(5) : ""}
          </small>
        ))}
      </div>
      {cols.length > 1 && (
        <div className="ops-legend">
          {cols.map((c, i) => (
            <span key={c} className={`s${i}`}>
              {c}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function Trends({
  data,
  scope,
  only,
}: {
  data: OpsData;
  scope: Scope;
  only?: TrendKey[];
}) {
  const keys = only ?? [...trendKeys];
  const [pick, setPick] = useState<TrendKey>(keys[0]!);
  const key = keys.includes(pick) ? pick : keys[0]!;
  const rows = data.trends[key];
  const cols = trendSeries[key].columns;
  let win = "";
  try {
    const t = trendDays(scope.day, scope.period);
    win =
      scope.period === "day"
        ? `近 7 日（至 ${t.end}）`
        : `${t.start} → ${t.end}`;
  } catch {}
  return (
    <Section
      title="趋势"
      id={`ops-trend-${keys.join("")}`}
      extra={<span className="ops-muted">{win}</span>}
    >
      {keys.length > 1 && (
        <div className="ops-tabs" role="tablist" aria-label="趋势指标">
          {keys.map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={k === key}
              onClick={() => setPick(k)}
            >
              {trendSeries[k].name}
            </button>
          ))}
        </div>
      )}
      {!rows ? (
        <PendingNote text={`${trendSeries[key].name}趋势待接入`} />
      ) : rows.length < 2 ? (
        <p className="ops-empty">数据不足：当前周期的数据点不足以形成趋势</p>
      ) : (
        <>
          <AreaChart rows={rows} cols={cols} />
          <details className="ops-details">
            <summary>查看明细</summary>
            <div className="ops-scroll">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>日期</th>
                    {cols.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.date}>
                      <td>{r.date}</td>
                      {r.values.map((v, i) => (
                        <td key={i}>{fmt(v)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </Section>
  );
}

export function GrowthPanel({
  data,
  full,
  onNavigate,
}: {
  data: OpsData;
  full?: boolean;
  onNavigate?: (t: string) => void;
}) {
  const g = data.growth;
  return (
    <Section
      title="Growth"
      id={`ops-growth${full ? "-full" : ""}`}
      extra={
        !full && (
          <More to="data:Growth" label="Growth 分析" onNavigate={onNavigate} />
        )
      }
    >
      <div className="ops-stats">
        <Stat
          label="Growth 发放"
          cell={g.issued}
          tip={coreMeta.growthIssued.tip}
        />
        <Stat
          label="Growth 获得人数"
          cell={g.earners}
          tip={coreMeta.growthEarners.tip}
        />
        <Stat
          label="Growth 净变化"
          cell={g.net}
          tip="发放减去扣回与修正后的净额（含 Correction）"
        />
        <Stat label="升级人数" cell={g.upgrades} tip={coreMeta.upgrades.tip} />
      </div>
      {full && (
        <>
          <h3 className="ops-sub">来源</h3>
          <div className="ops-stats">
            <Stat label="平台行为" cell={g.sources.platform} />
            <Stat label="邀请" cell={g.sources.referral} />
            <Stat label="任务" cell={g.sources.task} />
            <Stat label="签到" cell={g.sources.checkin} />
          </div>
          <details className="ops-details">
            <summary>高级详情 · 经济安全</summary>
            <div className="ops-stats">
              <Stat
                label="理论值"
                cell={g.theoretical}
                tip="按规则应发放的 Growth"
              />
              <Stat label="实际值" cell={g.actual} tip="实际入账的 Growth" />
              <Stat
                label="Correction"
                cell={g.correction}
                tip="人工或系统修正的 Growth"
              />
              <Stat
                label="Daily Cap"
                cell={g.dailyCap}
                tip="每日 Growth 上限（后端配置）"
              />
            </div>
            {g.advanced && (
              <dl className="ops-dl">
                {g.advanced.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>
                      <code>{v}</code>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </details>
        </>
      )}
    </Section>
  );
}

export function LevelDistribution({ data }: { data: OpsData }) {
  const lv = data.levels;
  const total = lv?.reduce((a, b) => a + Number(b.n), 0) ?? 0;
  return (
    <Section
      title="等级分布"
      id="ops-levels"
      extra={<span className="ops-muted">期末快照</span>}
    >
      {!lv ? (
        <PendingNote text="等级分布待接入" />
      ) : (
        <ul className="ops-levels">
          {lv.map((l) => {
            const pct = share(
              { s: "value", v: l.n },
              { s: "value", v: String(total) },
            );
            return (
              <li key={l.level}>
                <b>LV{l.level}</b>
                <div className="ops-track">
                  <i style={{ width: pct ?? "0%" }} />
                </div>
                <span>{fmt({ s: "value", v: l.n })} 人</span>
                <small>{pct ?? "—"}</small>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

export function PointsPanel({
  data,
  onNavigate,
  full,
}: {
  data: OpsData;
  onNavigate?: (t: string) => void;
  full?: boolean;
}) {
  const p = data.points;
  return (
    <Section
      title="Points"
      id="ops-points"
      extra={
        !full && (
          <More to="data:Points" label="Points 分析" onNavigate={onNavigate} />
        )
      }
    >
      <div className="ops-stats">
        <Stat
          label="Points 发放"
          cell={p.issued}
          tip="业务发放（不含退款返还）"
        />
        <Stat label="Points 消耗" cell={p.spent} tip="兑换等业务消耗" />
        <Stat label="Points 过期" cell={p.expired} />
        <Stat label="兑换申请" cell={p.redeemed} />
        <Stat
          label="Outstanding"
          cell={p.outstanding}
          tip="当前未使用的 Points 余额（快照）"
        />
      </div>
      <p className="ops-muted small">
        流水口径：入账 {fmt(p.credit)} · 扣减 {fmt(p.debit)}
      </p>
    </Section>
  );
}

export const funnelSteps = [
  ["initiated", "邀请发起"],
  ["registered", "注册"],
  ["bound", "平台绑定"],
  ["qualified", "有效邀请"],
  ["rewarded", "奖励发放"],
] as const;
/** Lowest adjacent conversion, only when every step is a value from the same payload. */
export function funnelDrop(f: OpsData["funnel"]) {
  const cells = funnelSteps.map(([k]) => f[k]);
  if (cells.some((c) => c.s !== "value")) return null;
  let min: { i: number; r: number } | null = null;
  for (let i = 1; i < cells.length; i++) {
    const a = Number((cells[i - 1] as { v: string }).v),
      b = Number((cells[i] as { v: string }).v);
    if (!(a > 0)) continue;
    const r = b / a;
    if (!min || r < min.r) min = { i, r };
  }
  return min && min.r < 1
    ? {
        index: min.i,
        from: funnelSteps[min.i - 1]![1],
        to: funnelSteps[min.i]![1],
        rate: `${(min.r * 100).toFixed(1)}%`,
      }
    : null;
}
export function ReferralFunnel({
  data,
  full,
  onNavigate,
}: {
  data: OpsData;
  full?: boolean;
  onNavigate?: (t: string) => void;
}) {
  const f = data.funnel;
  const top = f.initiated;
  const r = data.referral;
  const drop = funnelDrop(f);
  const allPending = funnelSteps.every(([k]) => f[k].s === "pending");
  return (
    <Section
      title="裂变漏斗"
      id={`ops-funnel${full ? "-full" : ""}`}
      extra={
        <span className="ops-head-extra">
          <Tip text="同一后端漏斗响应、同一周期与范围；有效邀请：被邀请人完成注册、绑定并达标" />
          {!full && (
            <More to="data:裂变" label="查看裂变详情" onNavigate={onNavigate} />
          )}
        </span>
      }
    >
      {allPending ? (
        <PendingNote
          text="裂变漏斗待接入"
          why="后端尚未提供同一口径的漏斗数据。"
        />
      ) : (
        <>
          {drop && (
            <p className="ops-drop" role="status">
              当前主要流失环节{" "}
              <b>
                {drop.from} → {drop.to}
              </b>{" "}
              <strong>{drop.rate}</strong>
            </p>
          )}
          <ol className="ops-funnel">
            {funnelSteps.map(([k, label], i) => {
              const c = f[k];
              const prev = i ? f[funnelSteps[i - 1]![0]] : null;
              const w = share(c, top);
              const conv = prev ? share(c, prev) : null;
              return (
                <li key={k} className={drop?.index === i ? "drop" : ""}>
                  <span className="ops-funnel-label">{label}</span>
                  <div className="ops-funnel-bar">
                    <i
                      style={{ width: c.s === "value" ? (w ?? "100%") : "0%" }}
                    />
                  </div>
                  <Value cell={c} />
                  <small>{prev ? `转化 ${conv ?? "—"}` : ""}</small>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {full && (
        <div className="ops-stats">
          <Stat label="发起邀请人数" cell={r.inviters} />
          <Stat label="被邀请用户数" cell={r.invitedUsers} />
          <Stat
            label="有效邀请人数"
            cell={r.qualified}
            tip={coreMeta.qualifiedInvites.tip}
          />
          <Stat
            label="有效率"
            cell={r.qualifiedRate}
            tip="整周期有效邀请 / 整周期注册，由后端计算"
          />
          <Stat label="Growth 奖励" cell={r.growthReward} />
        </div>
      )}
    </Section>
  );
}

export function Retention({
  data,
  full,
  onNavigate,
}: {
  data: OpsData;
  full?: boolean;
  onNavigate?: (t: string) => void;
}) {
  const rows = data.retention;
  const head = rows?.[0];
  return (
    <Section
      title="留存"
      id={`ops-retention${full ? "-full" : ""}`}
      extra={
        <span className="ops-head-extra">
          <Tip
            text={
              data.retentionDefinition ??
              "D1/D3/D7：Cohort 口径由后端提供，前端不自行定义"
            }
          />
          {!full && (
            <More to="data:留存" label="查看留存详情" onNavigate={onNavigate} />
          )}
        </span>
      }
    >
      {!rows || !head ? (
        <PendingNote
          text="留存数据待接入"
          why="后端尚未提供统一 Cohort 口径。"
        />
      ) : (
        <>
          <div className="ops-ret-top" aria-label="核心留存">
            {(["d1", "d3", "d7"] as const).map((d) => (
              <div key={d} className="ops-ret-card">
                <span>
                  {d.toUpperCase()} 留存 <small>{head.segment}</small>
                </span>
                <Value cell={head[d]} big />
              </div>
            ))}
          </div>
          {full && (
            <div className="ops-scroll">
              <table className="ops-table ops-retention">
                <thead>
                  <tr>
                    <th>人群</th>
                    <th>D1</th>
                    <th>D3</th>
                    <th>D7</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.segment}>
                      <td>{r.segment}</td>
                      <td>
                        <Value cell={r.d1} />
                      </td>
                      <td>
                        <Value cell={r.d3} />
                      </td>
                      <td>
                        <Value cell={r.d7} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

/** Dashboard block C · 运营投入: real backend values only; no ROI, face value ≠ cost. */
function Investment({
  data,
  onNavigate,
}: {
  data: OpsData;
  onNavigate?: (t: string) => void;
}) {
  const inv = data.investment ?? {
    growth: data.growth.issued,
    points: data.points.issued,
    rewards: data.points.redeemed,
  };
  return (
    <Section
      title="运营投入"
      id="ops-invest"
      extra={
        <More
          to="data:Growth"
          label="Growth / Points 分析"
          onNavigate={onNavigate}
        />
      }
    >
      <div className="ops-stats">
        <Stat
          label="Growth 发放"
          cell={inv.growth}
          tip={coreMeta.growthIssued.tip}
        />
        <Stat
          label="Points 发放"
          cell={inv.points}
          tip="业务发放（不含退款返还）"
        />
        <Stat
          label="兑换奖励"
          cell={inv.rewards}
          tip="周期内兑换次数；面额不等于公司成本，不计算 ROI"
        />
      </div>
    </Section>
  );
}

export default function OpsCenter(props: OpsCenterProps) {
  const { data, loading, error, scope, mode, onNavigate } = props;
  const [own, setOwn] = useState<DataDomain>("私域成效");
  const domain = props.domain ?? own;
  const setDomain = (d: DataDomain) =>
    props.onDomain ? props.onDomain(d) : setOwn(d);
  const pName = props.platforms.find(
    (p) => p.id === scope.platform,
  )?.display_name;
  const nav = (t: string) => {
    if (t.startsWith("data:") && mode === "data")
      setDomain(t.slice(5) as DataDomain);
    else onNavigate?.(t);
  };
  return (
    <div className="ops">
      <FilterBar {...props} />
      <Context data={data} scope={scope} tech={props.scopeLabel} />
      {error && (
        <div role="alert" className="ops-alert">
          数据读取失败，请稍后点击刷新重试。
          <details>
            <summary>技术信息</summary>
            <code>{error}</code>
          </details>
        </div>
      )}
      {scope.platform && !data?.preview && (
        <p role="status" className="ops-info">
          已选择 Platform：后端尚未提供指标的 supportedScopes，Bot 级汇总无法按
          Platform 归属，相关指标显示为待接入。
        </p>
      )}
      {scope.platform && data?.preview && (
        <p role="status" className="ops-info">
          Platform 视图：显示为「—」的指标不支持 Platform
          范围（不适用），不会用市场整体数据代替。
        </p>
      )}
      {!data ? (
        <div className="ops-skeleton" aria-busy="true">
          {loading ? (
            <>
              <i />
              <i />
              <i />
            </>
          ) : (
            "当前范围暂无数据，请调整日期或平台后再试"
          )}
        </div>
      ) : mode === "overview" ? (
        <>
          <section className="ops-panel" aria-labelledby="ops-scale">
            <div className="ops-panel-head">
              <h2 id="ops-scale">私域规模</h2>
            </div>
            <CoreGrid data={data} platformName={pName} />
          </section>
          <PerfBlock data={data} onNavigate={nav} />
          <Investment data={data} onNavigate={nav} />
          <PendingCenter data={data} onNavigate={onNavigate} />
          <p className="ops-muted small">
            趋势、等级分布、Growth 来源、Points
            明细、裂变漏斗与留存在「数据」中查看。
          </p>
        </>
      ) : (
        <>
          <div className="ops-tabs domain" role="tablist" aria-label="数据模块">
            {dataDomains.map((d) => (
              <button
                key={d}
                role="tab"
                aria-selected={domain === d}
                onClick={() => setDomain(d)}
              >
                {d}
              </button>
            ))}
          </div>
          {domain === "私域成效" && (
            <PerfPage data={data} platformName={pName} />
          )}
          {domain === "会员" && (
            <>
              <div className="ops-stats wide">
                <Stat
                  label="会员人数"
                  cell={data.metrics.members}
                  tip={coreMeta.members.tip}
                />
                <Stat
                  label="升级人数"
                  cell={data.metrics.upgrades}
                  tip={coreMeta.upgrades.tip}
                />
                <Stat
                  label="已绑定用户"
                  cell={data.metrics.boundUsers}
                  tip={coreMeta.boundUsers.tip}
                />
              </div>
              <div className="ops-row">
                <LevelDistribution data={data} />
                <Trends data={data} scope={scope} only={["members"]} />
              </div>
            </>
          )}
          {domain === "Growth" && (
            <>
              <GrowthPanel data={data} full />
              <div className="ops-row">
                <LevelDistribution data={data} />
                <Trends data={data} scope={scope} only={["growth"]} />
              </div>
            </>
          )}
          {domain === "Points" && (
            <>
              <PointsPanel data={data} full />
              <Trends data={data} scope={scope} only={["points"]} />
            </>
          )}
          {domain === "裂变" && (
            <>
              <ReferralFunnel data={data} full />
              <Trends data={data} scope={scope} only={["qualified"]} />
            </>
          )}
          {domain === "留存" && <Retention data={data} full />}
        </>
      )}
    </div>
  );
}
