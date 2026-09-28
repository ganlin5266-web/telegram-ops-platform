import { useEffect, useState } from "react";
import { request } from "../api";
export function MemberMetrics({ brandId }: { brandId: string }) {
  const [period, setPeriod] = useState("day"),
    [day, setDay] = useState(new Date().toISOString().slice(0, 10)),
    [data, setData] = useState<any>(),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setData(undefined);
    setError("");
    const start = new Date(day + "T00:00:00Z"),
      end = new Date(start);
    if (period === "week") {
      start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
      end.setTime(+start);
      end.setUTCDate(end.getUTCDate() + 6);
    }
    if (period === "month") {
      start.setUTCDate(1);
      end.setUTCMonth(end.getUTCMonth() + 1, 0);
    }
    if (!Number.isFinite(+start)) return;
    request<any>(
      `/v1/brands/${brandId}/members/analytics?from=${start.toISOString().slice(0, 10)}&to=${end.toISOString().slice(0, 10)}`,
    )
      .then((r) => {
        if (live) setData(r);
      })
      .catch(() => {
        if (live) setError("会员指标暂不可用或无品牌级读取权限");
      });
    return () => {
      live = false;
    };
  }, [brandId, period, day]);
  return (
    <section className="panel">
      <h3>品牌会员数据</h3>
      <p>按品牌会员时区统计；独立于 Bot 积分指标。</p>
      <label>
        会员统计日期
        <input
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
        />
      </label>
      <label>
        会员统计周期
        <select value={period} onChange={(e) => setPeriod(e.target.value)}>
          <option value="day">日</option>
          <option value="week">周</option>
          <option value="month">月</option>
        </select>
      </label>
      {error ? (
        <p role="status">{error}</p>
      ) : !data ? (
        <p>正在读取</p>
      ) : !data.available ? (
        <p>会员指标待接入</p>
      ) : (
        <>
          <p>业务时区：{data.timezone}</p>
          <div className="cards">
            {[
              ["会员人数", data.members],
              ["Growth 发放", data.issued],
              ["Growth 净变化", data.net],
              ["Growth 获得人数", data.earners],
              ["升级人数", data.upgrades],
            ].map(([label, value]) => (
              <div key={label}>
                <small>{label}</small>
                <p>{value}</p>
              </div>
            ))}
          </div>
          <p>
            等级分布：
            {data.distribution
              .map((d: any) => `LV${d.level}：${d.n}`)
              .join(" / ")}
          </p>
        </>
      )}
    </section>
  );
}
