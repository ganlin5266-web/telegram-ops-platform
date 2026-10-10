import { useEffect, useState } from "react";
import OpsCenter, { type DataDomain } from "./OpsCenter";
import { useRuntimeOps } from "./runtime";
import { dayInZone } from "../metrics";
import type { Scope } from "./model";

export default function RuntimeOps(props: {
  base: string;
  brandId: string;
  permissions: string[];
  onExpire: () => void;
  mode: "overview" | "data";
  scopeLabel: { brand: string; bot: string };
  onNavigate?: (target: string) => void;
  domain?: DataDomain;
  onDomain?: (d: DataDomain) => void;
}) {
  const [zone, setZone] = useState("UTC");
  const [scope, setScope] = useState<Scope>({
    period: "day",
    day: dayInZone(new Date(), "UTC"),
    platform: "",
    market: "",
  });
  const [revision, setRevision] = useState(0);
  const r = useRuntimeOps({ ...props, scope, zone, revision });
  // Business day follows the Bot/Brand timezone returned by the backend.
  useEffect(() => {
    const tz = r.data.timezone;
    if (tz && tz !== zone) {
      setZone(tz);
      setScope((s) => ({ ...s, day: dayInZone(new Date(), tz) }));
    }
  }, [r.data.timezone]);
  if (!r.allowed)
    return <section className="panel">你没有查看运营数据的权限</section>;
  return (
    <OpsCenter
      data={r.data}
      loading={r.loading}
      error={r.error}
      scope={scope}
      onScope={setScope}
      platforms={r.platforms}
      scopeLabel={props.scopeLabel}
      mode={props.mode}
      onNavigate={props.onNavigate}
      domain={props.domain}
      onDomain={props.onDomain}
      onRefresh={() => setRevision((n) => n + 1)}
    />
  );
}
