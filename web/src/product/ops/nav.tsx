// Admin global navigation (frozen IA): 9 first-level domains, one level only.
// Sub-pages live in in-page tabs. Hiding an entry is never access control —
// the backend stays the permission authority.
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import "./admin-shell.css";

export const domains = [
  ["overview", "总览"],
  ["users", "用户"],
  ["membership", "会员"],
  ["content", "内容"],
  ["activities", "活动"],
  ["points", "积分"],
  ["games", "游戏"],
  ["data", "数据"],
  ["settings", "设置"],
] as const;
export type Domain = (typeof domains)[number][0];

/** Existing pages → owning domain (Legacy / Existing Page Mapping). */
export const legacyDomain: Record<string, Domain> = {
  identities: "users",
  entitlements: "membership",
  "point-expiry": "points",
  redemptions: "points",
  "daily-data": "data",
  platforms: "settings",
};
export const domainOf = (page: string): Domain =>
  (legacyDomain[page] ??
    (domains.some(([d]) => d === page) ? page : "overview")) as Domain;

const paths: Record<Domain, string> = {
  overview: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  users:
    "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c1.2-3.5 4.2-5 8-5s6.8 1.5 8 5",
  membership:
    "M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z",
  content: "M4 12l16-8-6 16-2.5-6.5zM11.5 13.5L20 4",
  activities: "M5 21V4M5 4h11l-2 4 2 4H5",
  points:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9.5c0-1.2 1.3-2 3-2s3 .8 3 2-1.3 1.8-3 2.2-3 1-3 2.3 1.3 2 3 2 3-.8 3-2M12 6v1.5M12 16.5V18",
  games:
    "M7 8h10a4 4 0 0 1 4 4v1a3 3 0 0 1-5.4 1.8L14.5 14h-5l-1.1.8A3 3 0 0 1 3 13v-1a4 4 0 0 1 4-4zM8 10.5v3M6.5 12h3M15.5 11.5h.01M17.5 13h.01",
  data: "M4 20h16M7 16v-5M12 16V6M17 16v-8",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
};
export function NavIcon({ d }: { d: Domain | "collapse" | "expand" }) {
  const p =
    d === "collapse"
      ? "M15 6l-6 6 6 6"
      : d === "expand"
        ? "M9 6l6 6-6 6"
        : paths[d];
  return (
    <svg
      className="adm-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={p} />
    </svg>
  );
}

export type SideMode = "full" | "rail" | "overlay";
/** Sidebar mode from the real available width (viewport or container). */
export function useSideMode(ref?: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  const [collapsed, setCollapsed] = useState(false); // session-only (wide)
  const [expanded, setExpanded] = useState(false); // session-only (compact)
  useEffect(() => {
    const el = ref?.current;
    if (el && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(
        ([e]) => e && setWidth(e.contentRect.width),
      );
      ro.observe(el);
      return () => ro.disconnect();
    }
    const on = () => setWidth(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [ref]);
  const wide = width >= 1180;
  const mode: SideMode = wide
    ? collapsed
      ? "rail"
      : "full"
    : expanded
      ? "overlay"
      : "rail";
  return {
    mode,
    width,
    toggle: () => (wide ? setCollapsed((c) => !c) : setExpanded((e) => !e)),
    close: () => setExpanded(false),
  };
}

export function AdminSidebar({
  active,
  onSelect,
  mode,
  onToggle,
  brand,
  env,
  badges = {},
  footer,
  className = "",
}: {
  active: Domain;
  onSelect: (d: Domain) => void;
  mode: SideMode;
  onToggle: () => void;
  brand: string;
  env?: string;
  badges?: Partial<Record<Domain, number>>;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <aside className={`adm-side ${className}`} data-mode={mode}>
      <div className="adm-brand">
        <b title={brand}>{brand}</b>
        <small>Growth Operations</small>
        {env && <em className="adm-env">{env}</em>}
      </div>
      <nav aria-label="一级导航">
        {domains.map(([id, label]) => {
          const on = active === id;
          const n = badges[id];
          return (
            <button
              key={id}
              className={on ? "active" : ""}
              aria-current={on ? "page" : undefined}
              title={label}
              onClick={() => onSelect(id)}
            >
              <NavIcon d={id} />
              <span className="adm-label">{label}</span>
              {!!n && n > 0 && (
                <span className="adm-badge" aria-label={`${n} 项待处理`}>
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <div className="adm-side-foot">
        {footer}
        <button
          className="adm-collapse"
          onClick={onToggle}
          aria-label={
            mode === "full" || mode === "overlay" ? "收起导航" : "展开导航"
          }
          title={
            mode === "full" || mode === "overlay" ? "收起导航" : "展开导航"
          }
        >
          <NavIcon d={mode === "rail" ? "expand" : "collapse"} />
          <span className="adm-label">收起导航</span>
        </button>
      </div>
    </aside>
  );
}

export function PageHeader({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children?: ReactNode;
}) {
  return (
    <header className="adm-head">
      <div>
        <h1>{title}</h1>
        {desc && <p>{desc}</p>}
      </div>
      {children && <div className="adm-head-actions">{children}</div>}
    </header>
  );
}

const landing: Record<
  "content" | "activities" | "games" | "settings",
  { title: string; note: string; items: [string, string][] }
> = {
  content: {
    title: "内容发布中心",
    note: "内容发布中心将在 Phase 4 完善",
    items: [
      ["创建内容", "下一阶段完善"],
      ["发布计划", "下一阶段完善"],
      ["发布记录", "下一阶段完善"],
      ["内容模板", "下一阶段完善"],
    ],
  },
  activities: {
    title: "活动",
    note: "活动引擎待接入，当前没有已上线的活动。",
    items: [
      ["活动列表", "待接入"],
      ["任务", "待接入"],
      ["会员活动", "待接入"],
      ["限时活动", "待接入"],
    ],
  },
  games: {
    title: "游戏",
    note: "游戏后端待接入，这里不提供概率、奖池或中奖配置。",
    items: [
      ["游戏列表", "待接入"],
      ["游戏机会", "待接入"],
    ],
  },
  settings: {
    title: "设置",
    note: "国家与市场、Telegram 资源、Platform 与数据接入等配置；多市场配置写入待后端接入，当前只读。",
    items: [
      ["国家与市场", "待接入"],
      ["Telegram资源", "待接入"],
      ["Platform", "平台管理"],
      ["数据接入", "待接入"],
      ["语言", "简体中文"],
    ],
  },
};
export function DomainLanding({ kind }: { kind: keyof typeof landing }) {
  const l = landing[kind];
  return (
    <div className="ops">
      <p className="ops-pending-note" role="status">
        {l.note}
      </p>
      <div className="adm-landing">
        {l.items.map(([name, state]) => (
          <section key={name} className="ops-panel">
            <h2>{name}</h2>
            <span className="ops-badge pending">{state}</span>
          </section>
        ))}
      </div>
      {kind === "settings" && (
        <details className="ops-panel ops-details">
          <summary>高级设置</summary>
          <p className="ops-muted">
            Mapping、Audit、系统诊断与平台数据等技术能力在正式后台的高级入口中保留。
          </p>
        </details>
      )}
    </div>
  );
}
