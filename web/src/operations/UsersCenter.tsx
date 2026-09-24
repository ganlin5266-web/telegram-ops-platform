import { useState } from "react";
import {
  date,
  datesQuery,
  parameters,
  Pager,
  Status,
  useDebounced,
  usePages,
  useRemote,
  type Fields,
} from "./query";
import { ReferralPanel } from "./panels";
export type User = {
  id: string;
  telegram_user_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  telegram_language_code: string | null;
  preferred_language: string | null;
  first_started_at: string | null;
  last_interaction_at: string | null;
  status: string;
};
export default function UsersCenter({
  base,
  botName,
  onSelect,
  onInvalidate,
  onExpire,
}: {
  base: string;
  botName: string;
  onSelect: (u: User, tab?: string) => void;
  onInvalidate: () => void;
  onExpire: () => void;
}) {
  const [fields, setFields] = useState<Fields>({}),
    [mobileFilters, setMobileFilters] = useState(false),
    [view, setView] = useState("users"),
    [refresh, setRefresh] = useState(0),
    [queryEpoch, setQueryEpoch] = useState(0);
  const query = parameters(datesQuery(fields)),
    settled = useDebounced(query),
    waiting = query !== settled;
  const users = usePages<User>(
    `${base}/users`,
    settled,
    onExpire,
    view === "users" && !waiting,
    queryEpoch,
  );
  const countParams = new URLSearchParams(query);
  countParams.delete("sort");
  countParams.delete("order");
  const countQuery = countParams.toString(),
    countSettled = useDebounced(countQuery),
    countWaiting = countQuery !== countSettled;
  const count = useRemote<{ total: string }>(
    view === "users" && !countWaiting
      ? `${base}/users/count${countSettled ? "?" + countSettled : ""}`
      : null,
    refresh,
    onExpire,
  );
  const update = (key: string, value: string) => {
    if (fields[key] === value) return;
    onInvalidate();
    setQueryEpoch((x) => x + 1);
    setFields((old) => ({ ...old, [key]: value }));
  };
  const filter = (
    <div className="filter-grid">
      <label>
        状态
        <select
          aria-label="用户状态"
          value={fields.status || ""}
          onChange={(e) => update("status", e.target.value)}
        >
          <option value="">全部状态</option>
          <option value="active">正常</option>
          <option value="blocked">已屏蔽</option>
          <option value="disabled">已停用</option>
        </select>
      </label>
      <label>
        语言来源
        <select
          aria-label="语言来源"
          value={fields.languageField || "telegram"}
          onChange={(e) => update("languageField", e.target.value)}
        >
          <option value="telegram">Telegram 语言</option>
          <option value="preferred">用户偏好语言</option>
        </select>
      </label>
      <label>
        语言代码
        <input
          aria-label="语言代码"
          placeholder="例如 pt-BR"
          maxLength={100}
          value={fields.language || ""}
          onChange={(e) => update("language", e.target.value)}
        />
      </label>
      {[
        ["startedFrom", "首次启动开始"],
        ["startedTo", "首次启动结束（不含）"],
        ["interactionFrom", "最后互动开始"],
        ["interactionTo", "最后互动结束（不含）"],
      ].map(([key, title]) => (
        <label key={key}>
          {title}
          <input
            aria-label={title}
            type="datetime-local"
            value={fields[key!] || ""}
            onChange={(e) => update(key!, e.target.value)}
          />
        </label>
      ))}
      <label>
        排序字段
        <select
          aria-label="排序字段"
          value={fields.sort || "id"}
          onChange={(e) => update("sort", e.target.value)}
        >
          <option value="id">用户 ID</option>
          <option value="first_started_at">首次启动时间</option>
          <option value="last_interaction_at">最后互动时间</option>
        </select>
      </label>
      <label>
        排序方向
        <select
          aria-label="排序方向"
          value={fields.order || "asc"}
          onChange={(e) => update("order", e.target.value)}
        >
          <option value="asc">升序</option>
          <option value="desc">降序</option>
        </select>
      </label>
      <button
        onClick={() => {
          onInvalidate();
          setQueryEpoch((x) => x + 1);
          setFields({});
        }}
      >
        重置筛选
      </button>
      <small>时间按本机时区输入，结束时间不包含在区间内。</small>
    </div>
  );
  return (
    <section className="panel user-center">
      <div className="tabs">
        <button
          className={view === "users" ? "selected" : ""}
          onClick={() => setView("users")}
        >
          用户列表
        </button>
        <button
          className={view === "referrals" ? "selected" : ""}
          onClick={() => {
            onInvalidate();
            setView("referrals");
          }}
        >
          邀请关系
        </button>
      </div>
      {view === "referrals" ? (
        <ReferralPanel base={base} onExpire={onExpire} />
      ) : (
        <>
          <div className="table-title">
            <h3>
              用户档案 <span className="badge">{botName}</span>
            </h3>
            <button
              disabled={users.loading || waiting}
              onClick={() => {
                onInvalidate();
                users.reload();
                setRefresh((x) => x + 1);
              }}
            >
              刷新
            </button>
          </div>
          <label className="search-label">
            搜索用户
            <input
              aria-label="搜索用户"
              placeholder="Telegram ID 精确匹配；Username / 姓名前缀"
              value={fields.q || ""}
              maxLength={100}
              onChange={(e) => update("q", e.target.value)}
            />
          </label>
          <div className="filter-desktop">{filter}</div>
          <button
            className="mobile-filter-button"
            onClick={() => setMobileFilters(true)}
          >
            筛选与排序
          </button>
          {mobileFilters && (
            <div className="filters-overlay">
              <section
                role="dialog"
                aria-modal="true"
                aria-label="筛选与排序"
                className="filters-sheet"
              >
                <div className="table-title">
                  <h3>筛选与排序</h3>
                  <button onClick={() => setMobileFilters(false)}>
                    完成筛选
                  </button>
                </div>
                {filter}
              </section>
            </div>
          )}
          <div className="result-count">
            {count.data && !countWaiting
              ? `共 ${count.data.total} 位用户`
              : count.error
                ? "总数暂不可用"
                : "正在读取结果总数…"}
            <small>余额在用户详情中按需读取</small>
          </div>
          <Status
            loading={false}
            error={
              count.error ? `总数读取失败：${count.error.message}` : undefined
            }
            retry={() => setRefresh((x) => x + 1)}
          />
          <Status
            loading={waiting || users.loading}
            error={users.error}
            empty={!users.data?.items.length}
            emptyText="当前批次暂无用户"
            retry={users.reload}
          />
          {!waiting && users.data && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {[
                      "用户 / Telegram ID",
                      "Username",
                      "Telegram 语言",
                      "偏好语言",
                      "首次启动",
                      "最后互动",
                      "状态",
                      "操作",
                    ].map((x) => (
                      <th key={x}>{x}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {users.data.items.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <strong>
                          {[u.first_name, u.last_name]
                            .filter(Boolean)
                            .join(" ") || "未提供姓名"}
                        </strong>
                        <small>{u.telegram_user_id}</small>
                      </td>
                      <td>{u.username ? `@${u.username}` : "—"}</td>
                      <td>{u.telegram_language_code || "暂无数据"}</td>
                      <td>{u.preferred_language || "未设置"}</td>
                      <td>{date(u.first_started_at)}</td>
                      <td>{date(u.last_interaction_at)}</td>
                      <td>
                        <span className="badge">{u.status}</span>
                      </td>
                      <td className="row-actions">
                        <button onClick={() => onSelect(u, "overview")}>
                          查看详情
                        </button>
                        <button onClick={() => onSelect(u, "points")}>
                          查看积分
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager
            page={{
              ...users,
              loading: waiting || users.loading,
              data: waiting ? undefined : users.data,
            }}
          />
        </>
      )}
    </section>
  );
}
