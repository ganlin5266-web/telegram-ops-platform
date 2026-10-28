import { useEffect, useState } from "react";
import { ApiError, request } from "../api";
import "./operations.css";
export type OperationsMetric = {
  key: string;
  label: string;
  status: "ok" | "forbidden" | "pending_collection";
  value: string | null;
  unit: "users" | "events" | "points";
  definition: string;
};
export type OperationsSummary = {
  window: { start: string; end: string; timezone: "UTC"; days: 7 };
  metrics: OperationsMetric[];
  notAFunnel: true;
};
type Props = { base: string; permissions: string[]; onExpire: () => void };
const labels: Record<string, [string, string]> = {
  mini_participants: ["Mini 参与用户", "成功认证的去重用户，不代表打开次数。"],
  uid_verified: ["UID 核实", "统计成功核实事件，不代表当前有效 UID 数。"],
  checkins: ["签到", "当前签到记录缺少可靠的 Bot 归属，暂不展示推算值。"],
  qualified_invites: [
    "邀请达标",
    "仅统计已评估证据，含超额未奖励；关闭奖励时未评估的邀请不计。",
  ],
  reward_points: [
    "邀请奖励发放",
    "邀请双方已实际发放的 Points 合计，不包含 Growth。",
  ],
  redemptions_created: ["兑换创建", "统计创建订单，不代表游戏平台核销。"],
  codes_claimed: ["兑换码领取", "已领取不等于游戏平台已核销。"],
};
export default function OperationsMetrics(props: Props) {
  if (!props.permissions.includes("dashboard.read"))
    return <section className="empty">你没有查看运营数据的权限。</section>;
  return (
    <Metrics
      key={props.base + ":" + [...props.permissions].sort().join(",")}
      {...props}
    />
  );
}
function Metrics({ base, onExpire }: Props) {
  const [data, setData] = useState<OperationsSummary>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setData(undefined);
    setError("");
    void request<OperationsSummary>(base + "/operations/metrics?days=7")
      .then((result) => {
        if (active) setData(result);
      })
      .catch((value) => {
        if (!active) return;
        if (value instanceof ApiError && value.status === 401) onExpire();
        else
          setError(
            value instanceof ApiError
              ? value.message
              : "运营数据查询失败，请重试。",
          );
      });
    return () => {
      active = false;
    };
  }, [base, refresh]);
  return (
    <section className="panel operations-metrics">
      <div className="table-title">
        <div>
          <h2>近 7 天运营数据</h2>
          <p className="muted">
            按事件发生时间统计；各项人群与单位不同，不作为严格转化漏斗。
          </p>
        </div>
        <button onClick={() => setRefresh((value) => value + 1)}>
          刷新运营数据
        </button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p role="status">正在加载运营数据…</p>
      ) : (
        <>
          <p className="muted">
            {data.window.start} → {data.window.end}（UTC）
          </p>
          <div className="operations-metrics-grid">
            {data.metrics.map((metric) => (
              <article
                className="operations-metric"
                key={metric.key}
                data-testid={"operation-metric-" + metric.key}
              >
                <span>{labels[metric.key]?.[0] ?? metric.label}</span>
                <strong>
                  {metric.status === "forbidden"
                    ? "无权限"
                    : metric.status === "pending_collection"
                      ? "待采集"
                      : (metric.value ?? "数据不完整")}
                </strong>
                {metric.status === "ok" && metric.value !== null && (
                  <small>
                    {
                      { users: "人", events: "次", points: "Points" }[
                        metric.unit
                      ]
                    }
                  </small>
                )}
                <small className="muted">
                  {labels[metric.key]?.[1] ?? metric.definition}
                </small>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
