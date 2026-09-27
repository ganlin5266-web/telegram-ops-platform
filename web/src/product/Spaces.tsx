import { adminText } from "./i18n";
import { useRemote, Status } from "../operations/query";
import { useState } from "react";
import { AuditPanel } from "../operations/panels";
import { productCopy as copy } from "./copy";
export function ProductSpace({
  kind,
}: {
  kind: "membership" | "activities" | "games";
}) {
  const labels = copy[kind];
  return (
    <div className="product-space">
      <section className="product-banner">
        <span className="eyebrow">MEMBER EXPERIENCE</span>
        <h2>
          {kind === "membership"
            ? adminText("message49")
            : kind === "activities"
              ? adminText("message50")
              : adminText("message51")}
        </h2>
        <p>{copy.unavailable}</p>
        {kind === "membership" && <p>{adminText("message52")}</p>}
      </section>
      <div className="space-grid">
        {labels.map((label, i) => (
          <section className="panel space-tile" key={label}>
            <span className="space-number">0{i + 1}</span>
            <h3>{label}</h3>
            <span className="badge">{copy.soon}</span>
            <p className="muted">{adminText("message53")}</p>
            <button disabled>{adminText("message54")}</button>
          </section>
        ))}
      </div>
      <section className="panel">
        <h3>{adminText("message55")}</h3>
        <div className="workflow">
          {copy.stages.map((s, i) => (
            <span key={s}>
              {i + 1}. {s}
            </span>
          ))}
        </div>
        <p className="muted">{adminText("message56")}</p>
      </section>
    </div>
  );
}
export function UserMembership() {
  return (
    <section className="panel">
      <h3>{adminText("message57")}</h3>
      <div className="cards">
        {[
          adminText("message58"),
          "Growth",
          adminText("message59"),
          adminText("message60"),
          adminText("message61"),
        ].map((s) => (
          <div key={s}>
            <small>{s}</small>
            <p>{adminText("message28")}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function AuditDisclosure({
  base,
  onExpire,
}: {
  base: string;
  onExpire: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="panel" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{adminText("message62")}</summary>
      {open && <AuditPanel base={base} onExpire={onExpire} />}
      <p>{adminText("message63")}</p>
    </details>
  );
}

export function UserPlatforms({
  base,
  userId,
  onExpire,
}: {
  base: string;
  userId: string;
  onExpire: () => void;
}) {
  const [cursors, setCursors] = useState<string[]>([""]);
  const [reload, setReload] = useState(0);
  const page = useRemote<{
    items: {
      id: string;
      platformName: string;
      uidMasked: string;
      status: string;
    }[];
    nextCursor: string | null;
  }>(
    base +
      "/platform-identities?" +
      new URLSearchParams({
        userId,
        limit: "20",
        ...(cursors.at(-1) ? { cursor: cursors.at(-1)! } : {}),
      }),
    reload,
    onExpire,
  );
  const states: Record<string, string> = {
    verified: adminText("message64"),
    pending: adminText("message65"),
    rejected: adminText("message66"),
    conflict: adminText("message67"),
    revoked: adminText("message68"),
  };
  return (
    <section className="panel">
      <h3>{adminText("message69")}</h3>
      <Status
        loading={page.loading}
        error={page.error?.message}
        empty={!page.data?.items.length}
        emptyText={adminText("message70")}
        retry={() => setReload((n) => n + 1)}
      />
      {page.data?.items.map((i) => (
        <div className="info-row" key={i.id}>
          <strong>{i.platformName}</strong>
          <span>{i.uidMasked}</span>
          <span className="badge">
            {states[i.status] || adminText("message71")}
          </span>
        </div>
      ))}
      <div className="product-subnav">
        <button
          disabled={page.loading || cursors.length < 2}
          onClick={() => setCursors((c) => c.slice(0, -1))}
        >
          {adminText("message72")}
        </button>
        <button
          disabled={page.loading || !page.data?.nextCursor}
          onClick={() => setCursors((c) => [...c, page.data!.nextCursor!])}
        >
          {adminText("message73")}
        </button>
      </div>
    </section>
  );
}
