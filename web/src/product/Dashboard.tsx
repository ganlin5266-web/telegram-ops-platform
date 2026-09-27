import { adminText } from "./i18n";
import { useEffect, useState } from "react";
import { useRemote } from "../operations/query";
import {
  metrics,
  metricValue,
  periodRange,
  dayInZone,
  type Period,
} from "./metrics";
type Props = {
  base: string;
  permissions: string[];
  onExpire: () => void;
  dataCenter?: boolean;
};
type Summary = {
  timezone: string;
  snapshotAt: string;
  realtime: unknown;
  period: unknown;
};
type Platform = {
  id: string;
  display_name: string;
  market: string;
  timezone: string;
};
export default function Dashboard({
  base,
  permissions,
  onExpire,
  dataCenter = false,
}: Props) {
  const [period, setPeriod] = useState<Period>("day"),
    [day, setDay] = useState(dayInZone(new Date(), "UTC")),
    [zone, setZone] = useState("UTC"),
    [platform, setPlatform] = useState(""),
    [market, setMarket] = useState(""),
    [module, setModule] = useState(adminText("message1")),
    [revision, setRevision] = useState(0);
  const allowed = permissions.includes("dashboard.read");
  let range: { from: string; to: string } | null = null;
  try {
    range = periodRange(day, period, zone);
  } catch {
    /* Do not issue an invalid range. */
  }
  const query = range ? new URLSearchParams(range).toString() : "";
  const summary = useRemote<Summary>(
    allowed && range ? `${base}/dashboard/summary?${query}` : null,
    revision,
    onExpire,
  );
  const platforms = useRemote<{ items: Platform[] }>(
    permissions.includes("platforms.read") ? `${base}/platforms` : null,
    0,
    onExpire,
  );
  useEffect(() => {
    if (summary.data?.timezone && summary.data.timezone !== zone) {
      setZone(summary.data.timezone);
      setDay(dayInZone(new Date(), summary.data.timezone));
    }
  }, [summary.data?.timezone]);
  const trendDay = new Date(day + "T00:00:00Z");
  trendDay.setUTCDate(trendDay.getUTCDate() - 6);
  let trendQuery = "";
  try {
    trendQuery = new URLSearchParams({
      from: periodRange(trendDay.toISOString().slice(0, 10), "day", zone).from,
      to: periodRange(day, "day", zone).to,
    }).toString();
  } catch {}
  const trends = useRemote<{
    items: {
      date: string;
      newUsers: number;
      pointsEarned: string;
      pointsSpent: string;
    }[];
  }>(
    allowed && trendQuery && !dataCenter && !platform && !market
      ? `${base}/dashboard/trends?${trendQuery}`
      : null,
    revision,
    onExpire,
  );
  const filtered = !!platform || !!market;
  const visible = metrics.filter((m) =>
    dataCenter
      ? module === adminText("message1") || m.module === module
      : ![
          "pointsExpiry",
          "pointsRefund",
          "pointsBalance",
          "inviteConversion",
          "deposit",
          "redemptions",
          "activityDone",
          "gameChances",
        ].includes(m.key),
  );
  if (!allowed)
    return <section className="panel">{adminText("message2")}</section>;
  return (
    <div className="product-dashboard">
      <section className="report-toolbar panel">
        <div className="segmented" aria-label={adminText("message3")}>
          {(
            [
              ["day", adminText("message4")],
              ["week", adminText("message5")],
              ["month", adminText("message6")],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              aria-pressed={period === v}
              onClick={() => setPeriod(v)}
            >
              {label}
            </button>
          ))}
        </div>
        <label>
          {adminText("message7")}
          <input
            aria-label={adminText("message8")}
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </label>
        <label>
          {adminText("message9")}
          <select
            aria-label={adminText("message10")}
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          >
            <option value="">{adminText("message11")}</option>
            {platforms.data?.items
              .filter((p) => !market || p.market === market)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
          </select>
        </label>
        <label>
          {adminText("message12")}
          <select
            aria-label={adminText("message13")}
            value={market}
            onChange={(e) => {
              setMarket(e.target.value);
              setPlatform("");
            }}
          >
            <option value="">{adminText("message14")}</option>
            {[...new Set(platforms.data?.items.map((p) => p.market) || [])].map(
              (m) => (
                <option key={m}>{m}</option>
              ),
            )}
          </select>
        </label>
        <button onClick={() => setRevision((n) => n + 1)}>
          {adminText("message15")}
        </button>
      </section>
      <p className="report-context">
        {zone} · {day} ·{" "}
        {period === "day"
          ? adminText("message4")
          : period === "week"
            ? adminText("message16")
            : adminText("message17")}
        {adminText("message18")}
      </p>
      {filtered && (
        <p role="status" className="language-note">
          {adminText("message19")}
        </p>
      )}
      {!range && <p role="alert">{adminText("message20")}</p>}
      {summary.error && <p role="alert">{summary.error.message}</p>}
      {platforms.error && (
        <p role="status">
          {adminText("message21")}
          {platforms.error.message}
        </p>
      )}
      {dataCenter && (
        <div className="product-subnav" aria-label={adminText("message22")}>
          {[
            adminText("message1"),
            adminText("message23"),
            adminText("message24"),
            "Growth",
            "Points",
            adminText("message25"),
            adminText("message26"),
            adminText("message27"),
            adminText("message9"),
          ].map((m) => (
            <button
              key={m}
              aria-pressed={module === m}
              onClick={() => setModule(m)}
            >
              {m}
            </button>
          ))}
        </div>
      )}
      <div className="metric-grid">
        {visible.map((m) => {
          const value = metricValue(m, summary.data, filtered);
          return (
            <article
              className={`metric-card ${value === null ? "unconnected" : ""}`}
              key={m.key}
            >
              <span>{m.name}</span>
              <strong>
                {m.path && summary.loading && !filtered
                  ? "…"
                  : value === null
                    ? adminText("message28")
                    : /^-?\d+$/.test(value)
                      ? new Intl.NumberFormat("zh-CN").format(BigInt(value))
                      : value}
              </strong>
              <small>
                {m.realtime
                  ? adminText("message29")
                  : m.aggregation === "DISTINCT"
                    ? adminText("message30")
                    : m.path
                      ? adminText(
                          m.key === "pointsCredit"
                            ? "periodCredit"
                            : m.key === "pointsDebit"
                              ? "periodDebit"
                              : "periodRecords",
                        )
                      : adminText("message31")}
              </small>
            </article>
          );
        })}
      </div>
      {!dataCenter && (
        <section className="panel product-trends">
          <div className="table-title">
            <h2>{adminText("message32")}</h2>
            <span className="muted">{adminText("message33")}</span>
          </div>
          {trends.error && <p role="alert">{trends.error.message}</p>}
          {filtered ? (
            <p>{adminText("message34")}</p>
          ) : (
            <>
              <div className="trend-chart" aria-label={adminText("message35")}>
                {trends.data?.items.map((r) => (
                  <div key={r.date}>
                    <span>{r.newUsers}</span>
                    <div
                      className="trend-bar"
                      style={{
                        height: `${Math.max(2, (r.newUsers / Math.max(1, ...trends.data!.items.map((x) => x.newUsers))) * 92)}px`,
                      }}
                    />
                    <small>{r.date.slice(5)}</small>
                  </div>
                ))}
              </div>
              <details>
                <summary>{adminText("message36")}</summary>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>{adminText("message7")}</th>
                        <th>{adminText("message37")}</th>
                        <th>{adminText("message38")}</th>
                        <th>{adminText("message39")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trends.data?.items.map((r) => (
                        <tr key={r.date}>
                          <td>{r.date}</td>
                          <td>{r.newUsers}</td>
                          <td>{r.pointsEarned}</td>
                          <td>{r.pointsSpent}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          )}
          <p className="muted">{adminText("message40")}</p>
        </section>
      )}
      <details className="panel metric-definitions">
        <summary>{adminText("message41")}</summary>
        <p>{adminText("message42")}</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{adminText("message43")}</th>
                <th>{adminText("message44")}</th>
                <th>{adminText("message45")}</th>
                <th>{adminText("message4")}</th>
                <th>{adminText("message5")}</th>
                <th>{adminText("message6")}</th>
                <th>{adminText("message46")}</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => (
                <tr key={m.key}>
                  <td>
                    {m.name}
                    <small>{m.key}</small>
                  </td>
                  <td>{m.source}</td>
                  <td>
                    {m.aggregation}
                    {m.deduplicated ? adminText("message47") : ""}
                  </td>
                  <td>{m.day}</td>
                  <td>{m.week}</td>
                  <td>{m.month}</td>
                  <td>
                    {m.unit} /{" "}
                    {m.platforms === "bot_scope_only"
                      ? adminText("message48")
                      : adminText("message28")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
