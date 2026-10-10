// 私域关联业绩 (TG-linked performance). Frozen 6 backend metrics; the UI never
// sums Platforms, averages rates, converts currency or reads raw files.
import { useState } from "react";
import {
  completenessText,
  fmt,
  perfKeys,
  perfMeta,
  perfTrendKeys,
  type Cell,
  type OpsData,
  type PerfKey,
} from "./model";

function V({ c, big }: { c: Cell; big?: boolean }) {
  return (
    <strong className={`ops-value ops-${c.s}${big ? " big" : ""}`}>
      {fmt(c)}
    </strong>
  );
}
const note = (c: Cell) =>
  c.s === "na" ? "不适用" : c.s === "incomplete" ? "待更新" : null;

const freshnessNull = {
  forbidden: "无权查看平台数据状态",
  error: "平台数据状态加载失败",
  pending: "数据状态待接入",
  empty: "暂无已启用 Platform 的数据状态",
} as const;
export function Freshness({
  f,
  state,
}: {
  f: NonNullable<OpsData["privateDomain"]>["freshness"];
  state?: NonNullable<OpsData["privateDomain"]>["freshnessState"];
}) {
  if (!f)
    return (
      <span
        className="ops-muted small"
        role={state === "error" ? "alert" : undefined}
      >
        {freshnessNull[state ?? "pending"]}
      </span>
    );
  return (
    <span className={`pd-fresh pd-${f.completeness}`} role="status">
      数据更新至 {f.latestBusinessDate} · 完整性：
      {completenessText[f.completeness]}
      {f.note && <small> · {f.note}</small>}
    </span>
  );
}

function Notice({ pd }: { pd: NonNullable<OpsData["privateDomain"]> }) {
  if (pd.failure)
    return (
      <p className="ops-muted small" role="alert">
        {pd.failure === "forbidden"
          ? "无权查看私域关联业绩（需要品牌级平台数据权限）"
          : pd.failure === "unsupported"
            ? "按国家筛选私域关联业绩暂不支持，请选择具体 Platform"
            : "私域关联业绩加载失败，请刷新重试"}
      </p>
    );
  return pd.notice ? <p className="ops-muted small">{pd.notice}</p> : null;
}

export function PerfCards({
  data,
  compact,
}: {
  data: OpsData;
  compact?: boolean;
}) {
  const pd = data.privateDomain;
  const cell = (k: PerfKey): Cell => pd?.metrics[k] ?? { s: "pending" };
  return (
    <div
      className={`pd-cards${compact ? " compact" : ""}`}
      aria-label="私域关联业绩指标"
    >
      {perfKeys.map((k) => {
        const c = cell(k);
        return (
          <article key={k} className={`ops-card ops-card-${c.s}`}>
            <span title={perfMeta[k].tip}>{perfMeta[k].name}</span>
            <V c={c} big={!compact} />
            {note(c) && <small className="ops-muted">{note(c)}</small>}
          </article>
        );
      })}
    </div>
  );
}

/** Dashboard block B: compact. */
export function PerfBlock({
  data,
  onNavigate,
}: {
  data: OpsData;
  onNavigate?: (t: string) => void;
}) {
  const pd = data.privateDomain;
  return (
    <section className="ops-panel" aria-labelledby="pd-block">
      <div className="ops-panel-head">
        <h2 id="pd-block">
          私域关联业绩
          <small className="pd-sub">已关联 Telegram 会员的平台业务表现</small>
        </h2>
        <span className="ops-head-extra">
          {pd && <Freshness f={pd.freshness} state={pd.freshnessState} />}
          {onNavigate && (
            <button
              className="ops-link"
              onClick={() => onNavigate("data:私域成效")}
            >
              查看私域成效 →
            </button>
          )}
        </span>
      </div>
      {!pd ? (
        <p className="ops-pending-note">
          私域关联业绩待接入
          <small>后端尚未提供 TG-linked 指标（BACKEND_PENDING）。</small>
        </p>
      ) : (
        <>
          <Notice pd={pd} />
          <PerfCards data={data} compact />
        </>
      )}
    </section>
  );
}

/** 数据 → 私域成效. */
export function PerfPage({
  data,
  platformName,
}: {
  data: OpsData;
  platformName?: string;
}) {
  const pd = data.privateDomain;
  const [pick, setPick] = useState<PerfKey>(perfTrendKeys[0]);
  if (!pd)
    return (
      <p className="ops-pending-note">
        私域关联业绩待接入
        <small>
          需要后端 TG-linked 口径、Platform
          标准数据与完整性（BACKEND_PENDING）。
        </small>
      </p>
    );
  const rows = pd.trends[pick];
  return (
    <>
      <section className="ops-panel" aria-labelledby="pd-page">
        <div className="ops-panel-head">
          <h2 id="pd-page">私域关联业绩 · {platformName ?? "全部 Platform"}</h2>
          <Freshness f={pd.freshness} state={pd.freshnessState} />
        </div>
        <p className="ops-muted small">
          口径：TG 关联用户（已验证 Platform 身份）的平台表现，不等于 Telegram
          直接带来的业绩（归因能力待接入）。
        </p>
        <Notice pd={pd} />
        <PerfCards data={data} />
      </section>
      <section className="ops-panel" aria-label="私域成效趋势">
        <div className="ops-tabs" role="tablist" aria-label="私域成效趋势">
          {perfTrendKeys.map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={k === pick}
              onClick={() => setPick(k)}
            >
              {perfMeta[k].name}
            </button>
          ))}
        </div>
        {!rows ? (
          <p className="ops-pending-note">{perfMeta[pick].name}趋势待接入</p>
        ) : (
          <div className="ops-scroll">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>业务日期</th>
                  <th>{perfMeta[pick].name}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.date}>
                    <td>{r.date}</td>
                    <td>{fmt(r.values[0] ?? { s: "pending" })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {!platformName && (
        <section className="ops-panel" aria-label="Platform Breakdown">
          <div className="ops-panel-head">
            <h2>Platform 对比</h2>
            <span className="ops-muted small">
              各 Platform 数值由后端返回；「全部」不由前端相加或平均
            </span>
          </div>
          {!pd.breakdown ? (
            <p className="ops-pending-note">Platform Breakdown 待接入</p>
          ) : (
            <div className="ops-scroll">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th>时区</th>
                    {(
                      [
                        "returnActive",
                        "depositors",
                        "depositAmount",
                        "repeatRate",
                        "netDeposit",
                      ] as const
                    ).map((k) => (
                      <th key={k}>{perfMeta[k].name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pd.breakdown.map((r) => (
                    <tr key={r.platform}>
                      <td>
                        <b>{r.name}</b>
                      </td>
                      <td className="ops-muted small">{r.timezone ?? "—"}</td>
                      {(
                        [
                          "returnActive",
                          "depositors",
                          "depositAmount",
                          "repeatRate",
                          "netDeposit",
                        ] as const
                      ).map((k) => {
                        const c = r.values[k] ?? { s: "pending" as const };
                        return (
                          <td key={k} className={`ops-${c.s}`}>
                            {fmt(c)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
