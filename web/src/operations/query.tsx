import { useEffect, useRef, useState } from "react";
import { ApiError, request } from "../api";
export type Fields = Record<string, string>;
export function parameters(values: Fields) {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value.trim()) p.set(key, value.trim());
  return p.toString();
}
export function useDebounced<T>(value: T, delay = 350) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
export function useRemote<T>(
  url: string | null,
  revision: number | string,
  onExpire: () => void,
) {
  const key = `${url}|${revision}`;
  const expire = useRef(onExpire);
  expire.current = onExpire;
  const [state, setState] = useState<{
    key: string;
    data?: T;
    error?: ApiError;
    loading: boolean;
  }>({ key: "", loading: false });
  useEffect(() => {
    if (!url) return;
    let current = true;
    setState({ key, loading: true });
    request<T>(url)
      .then((data) => {
        if (current) setState({ key, data, loading: false });
      })
      .catch((error) => {
        if (!current) return;
        if (error instanceof ApiError && error.status === 401) expire.current();
        else setState({ key, error, loading: false });
      });
    return () => {
      current = false;
    };
  }, [url, revision]);
  return url
    ? state.key === key
      ? state
      : { key, loading: true }
    : { key, loading: false };
}
export type Page<T> = { items: T[]; nextCursor: string | null };
export function usePages<T, E extends Page<T> = Page<T>>(
  base: string,
  query: string,
  onExpire: () => void,
  enabled = true,
  revision = 0,
) {
  const key = `${base}?${query}|${revision}`;
  const [position, setPosition] = useState({
    key: "",
    history: [null] as (string | null)[],
  });
  const [blocked, setBlocked] = useState(""),
    [refresh, setRefresh] = useState(0);
  const history = position.key === key ? position.history : [null];
  const p = new URLSearchParams(query);
  p.set("limit", "50");
  const after = history.at(-1);
  if (after) p.set("after", after);
  const remote = useRemote<E>(
    enabled && blocked !== key ? `${base}?${p}` : null,
    `${revision}:${refresh}`,
    onExpire,
  );
  useEffect(() => {
    if (remote.error?.code === "invalid_cursor") {
      setPosition({ key, history: [null] });
      setBlocked(key);
    }
  }, [remote.error, key]);
  const invalid = blocked === key || remote.error?.code === "invalid_cursor";
  return {
    ...remote,
    data: invalid ? undefined : remote.data,
    error: invalid ? "查询条件已变化，请重新加载。" : remote.error?.message,
    loading: enabled && remote.loading,
    history,
    previous: () => setPosition({ key, history: history.slice(0, -1) }),
    next: () => {
      if (remote.data?.nextCursor)
        setPosition({ key, history: [...history, remote.data.nextCursor] });
    },
    reload: () => {
      setPosition({ key, history: [null] });
      setBlocked("");
      setRefresh((x) => x + 1);
    },
  };
}
export function Status({
  loading,
  error,
  empty,
  emptyText,
  retry,
}: {
  loading: boolean;
  error?: string;
  empty?: boolean;
  emptyText?: string;
  retry?: () => void;
}) {
  return (
    <>
      {loading && <p role="status">正在加载…</p>}
      {error && (
        <div className="alert" role="alert">
          {error}
          {retry && <button onClick={retry}>重新加载</button>}
        </div>
      )}
      {!loading && !error && empty && <div className="empty">{emptyText}</div>}
    </>
  );
}
export function Pager({
  page,
}: {
  page: {
    loading: boolean;
    history: (string | null)[];
    data?: Page<unknown>;
    error?: string;
    previous: () => void;
    next: () => void;
  };
}) {
  return (
    <div className="pagination">
      <small>每批最多 50 条 · 按服务端游标读取</small>
      <div>
        <button
          disabled={page.loading || !!page.error || page.history.length === 1}
          onClick={page.previous}
        >
          上一批
        </button>
        <button
          disabled={page.loading || !!page.error || !page.data?.nextCursor}
          onClick={page.next}
        >
          下一批
        </button>
      </div>
    </div>
  );
}
export const date = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN") : "暂无数据";
export function DateFields({
  fields,
  onChange,
  prefix = "",
}: {
  fields: Fields;
  onChange: (key: string, value: string) => void;
  prefix?: string;
}) {
  return (
    <>
      {[
        ["from", "开始时间"],
        ["to", "结束时间（不含）"],
      ].map(([key, title]) => (
        <label key={key}>
          {prefix}
          {title}
          <input
            aria-label={prefix + title}
            type="datetime-local"
            value={fields[key!] || ""}
            onChange={(e) => onChange(key!, e.target.value)}
          />
        </label>
      ))}
    </>
  );
}
export function datesQuery(fields: Fields) {
  const result = { ...fields };
  for (const name of [
    "from",
    "to",
    "startedFrom",
    "startedTo",
    "interactionFrom",
    "interactionTo",
  ])
    if (result[name]) result[name] = new Date(result[name]!).toISOString();
  return result;
}
