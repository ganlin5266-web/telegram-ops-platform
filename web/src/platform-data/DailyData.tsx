import { useEffect, useState } from "react";
import { request, json, ApiError } from "../api";
const fields = [
  "uid",
  "tier",
  "login_account",
  "registered_at",
  "login_time",
  "channel",
  "agent",
  "deposit",
  "deposit_count",
  "gift",
  "withdrawal",
  "source_net",
  "bet",
  "payout",
  "game_profit",
  "first_deposit_date",
  "first_deposit",
];
const mappingDefault = JSON.stringify(
  Object.fromEntries(fields.map((k) => [k, k])),
  null,
  2,
);
const display = (v: unknown) =>
  v === null || v === undefined
    ? "未提供"
    : typeof v === "object"
      ? JSON.stringify(v)
      : String(v);
export default function DailyData({
  base,
  permissions,
  csrf,
  onExpire,
}: {
  base: string;
  permissions: string[];
  csrf: string;
  onExpire: () => void;
}) {
  const [platforms, setPlatforms] = useState<any[]>([]),
    [platformId, setPlatform] = useState(""),
    [date, setDate] = useState(""),
    [completeness, setCompleteness] = useState("unknown"),
    [coverage, setCoverage] = useState("full"),
    [filter, setFilter] = useState(""),
    [mapping, setMapping] = useState(mappingDefault),
    [adapter, setAdapter] = useState(""),
    [reason, setReason] = useState(""),
    [replacement, setReplacement] = useState(false),
    [file, setFile] = useState<File>(),
    [batches, setBatches] = useState<any[]>([]),
    [facts, setFacts] = useState<any[]>([]),
    [detail, setDetail] = useState<any>(),
    [fact, setFact] = useState<any>(),
    [raw, setRaw] = useState<any>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false),
    [status, setStatus] = useState(""),
    [uid, setUid] = useState(""),
    [linked, setLinked] = useState(""),
    [freshness, setFreshness] = useState<boolean | null>(null),
    [offset, setOffset] = useState(0),
    [next, setNext] = useState<number | null>(null);
  const endpoint = base + "/platform-data",
    platform = platforms.find((p) => p.id === platformId);
  const canRead = permissions.includes("platform_data.read"),
    canImport = permissions.includes("platform_data.import"),
    canActivate = permissions.includes("platform_data.activate");
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onExpire();
      setError(
        e instanceof ApiError
          ? e.message + (e.code ? " (" + e.code + ")" : "")
          : "输入或文件格式无效，请检查",
      );
    } finally {
      setBusy(false);
    }
  }
  async function load(n = 0) {
    if (!platformId) return;
    const q = new URLSearchParams({ platformId, offset: String(n) });
    if (date) q.set("businessDate", date);
    if (status) q.set("status", status);
    if (uid) q.set("uid", uid);
    if (linked) q.set("linked", linked);
    if (completeness !== "unknown") q.set("completeness", completeness);
    const [b, f] = await Promise.all([
      request<any>(endpoint + "/batches?" + q),
      request<any>(endpoint + "/facts?" + q),
    ]);
    setBatches(b.items);
    setFacts(f.items);
    setFreshness(b.freshness?.complete_active ?? null);
    setOffset(n);
    setNext(b.nextOffset ?? f.nextOffset);
  }
  async function open(id: string) {
    setDetail(await request(endpoint + "/batches/" + id));
    setConfirm(false);
    setRaw(undefined);
  }
  useEffect(() => {
    if (canRead)
      void run(async () => {
        const p = await request<any>(base + "/platforms");
        setPlatforms(p.items);
        setPlatform(p.items[0]?.id ?? "");
      });
  }, [base]);
  useEffect(() => {
    if (platformId && canRead) void run(() => load());
  }, [platformId]);
  async function upload() {
    if (!file || !platform) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > 2000000) throw Error();
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    const r = await request<any>(
      endpoint + "/preflight",
      json(
        {
          platformId,
          businessDate: date,
          timezone: platform.timezone,
          currency: platform.currency,
          sourceType: file.name.toLowerCase().endsWith(".xlsx")
            ? "xlsx"
            : "csv",
          filename: file.name,
          fileBase64: btoa(binary),
          mapping: adapter ? {} : JSON.parse(mapping),
          ...(adapter ? { adapter: { id: adapter, version: "1" } } : {}),
          coverage: {
            kind: coverage,
            filter: coverage === "full" ? "" : filter,
          },
          completeness,
          replacement,
          reason,
        },
        csrf,
      ),
    );
    await open(r.id);
    await load();
  }
  if (!canRead) return <section>没有平台数据读取权限。</section>;
  return (
    <section className="panel">
      <h2>平台数据 · 用户日报</h2>
      <p>
        平台事实不等于福利资格。上传先预检，确认激活后才成为当前事实；未提供的数据不会当作
        0。
      </p>
      <label>
        平台
        <select
          value={platformId}
          disabled={busy}
          onChange={(e) => {
            setPlatform(e.target.value);
            setDetail(undefined);
            setFact(undefined);
          }}
        >
          {platforms.map((p) => (
            <option key={p.id} value={p.id}>
              {p.display_name} · {p.code}
            </option>
          ))}
        </select>
      </label>
      <label>
        业务日期
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          disabled={busy}
        />
      </label>
      <p>
        时区：{platform?.timezone ?? "—"} · 币种：{platform?.currency ?? "—"}
        。日期必须来自导出任务选择，不从文件或登录时间推断。
      </p>
      <label>
        完整性
        <select
          value={completeness}
          onChange={(e) => setCompleteness(e.target.value)}
        >
          <option value="unknown">未知（默认）</option>
          <option value="complete">完整日报</option>
          <option value="incomplete">部分数据</option>
        </select>
      </label>
      {canImport && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(upload);
          }}
        >
          <h3>上传与预检</h3>
          <label>
            报表适配版本
            <select
              value={adapter}
              onChange={(e) => setAdapter(e.target.value)}
            >
              <option value="">
                明确列映射 v1（现有 FUN66 流程，金额原单位）
              </option>
              <option value="player-report-minor-units">
                第二平台玩家报表 v1（money ÷100；首充1900哨兵）
              </option>
              <option value="synthetic-mx">MX 合成示例 v1（仅测试）</option>
            </select>
          </label>
          {adapter && (
            <p>
              仅使用已批准的精确列结构；未知列拒绝。平台时区和币种来自所选平台。请在预检中核对转换与未确认语义。
            </p>
          )}
          <label>
            Excel / CSV
            <input
              type="file"
              accept=".xlsx,.csv"
              required
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0])}
            />
          </label>
          <label>
            导入说明
            <input
              value={reason}
              maxLength={160}
              required
              onChange={(e) => setReason(e.target.value)}
              placeholder="测试数据请标记 STAGING SYNTHETIC"
            />
          </label>
          <label>
            覆盖范围
            <select
              value={coverage}
              onChange={(e) => setCoverage(e.target.value)}
            >
              <option value="full">全量范围</option>
              <option value="filtered">筛选范围</option>
            </select>
          </label>
          {coverage === "filtered" && (
            <label>
              导出筛选条件
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                maxLength={300}
              />
            </label>
          )}
          <label>
            <input
              type="checkbox"
              checked={replacement}
              onChange={(e) => setReplacement(e.target.checked)}
            />
            这是同日、同范围修正版（仍需预检与确认）
          </label>
          <details>
            <summary>列映射与格式说明</summary>
            <p>
              默认使用下列精确英文列名，不按相似名称猜测。自定义文件请显式修改
              mapping；未提供的可选列应删除对应项。金额使用小数点，不含千分位/货币符号，最多
              6 位小数；时间必须是带 UTC offset 的 ISO 文本，Excel
              日期请以文本保存。
            </p>
            <label>
              显式列映射 JSON
              <textarea
                rows={10}
                value={mapping}
                onChange={(e) => setMapping(e.target.value)}
              />
            </label>
          </details>
          <button disabled={busy || !platformId || !date || !file || !reason}>
            上传并预检
          </button>
        </form>
      )}
      <h3>查询</h3>
      <label>
        批次状态
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部</option>
          {["ready", "active", "rejected", "review_required", "superseded"].map(
            (s) => (
              <option key={s}>{s}</option>
            ),
          )}
        </select>
      </label>
      <label>
        UID 精确查询
        <input
          value={uid}
          autoComplete="off"
          onChange={(e) => setUid(e.target.value)}
        />
      </label>
      <label>
        Telegram 关联
        <select value={linked} onChange={(e) => setLinked(e.target.value)}>
          <option value="">全部</option>
          <option value="yes">已关联</option>
          <option value="no">未关联</option>
        </select>
      </label>
      <button disabled={busy} onClick={() => void run(() => load())}>
        查询 / 刷新
      </button>
      {freshness !== null && (
        <p>
          该日完整批次：
          {freshness
            ? "已有 complete active batch"
            : "待更新 / 尚无完整有效批次"}
        </p>
      )}
      <h3>导入批次</h3>
      <table>
        <thead>
          <tr>
            <th>日期 / 文件</th>
            <th>状态 / 完整性</th>
            <th>行数 / 错误 / 警告</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id}>
              <td>
                {b.business_date} · {b.original_filename}
              </td>
              <td>
                {b.status} / {b.completeness}
              </td>
              <td>
                {b.row_count} / {b.rejected_rows} / {b.warning_rows}
              </td>
              <td>
                <button
                  disabled={busy}
                  onClick={() => void run(() => open(b.id))}
                >
                  预检详情
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {detail && (
        <section aria-label="批次详情">
          <h3>批次详情</h3>
          <p>
            {detail.batch.business_date} · {detail.batch.timezone} ·{" "}
            {detail.batch.currency} · {detail.batch.status}
          </p>
          <p>文件 SHA256：{detail.batch.file_digest}</p>
          <details>
            <summary>Schema / Mapping Version / 转换规则</summary>
            <pre>{JSON.stringify(detail.batch.mapping, null, 2)}</pre>
          </details>
          <p>
            可接受 {detail.batch.accepted_rows} / 拒绝{" "}
            {detail.batch.rejected_rows} / 警告 {detail.batch.warning_rows}
          </p>
          <ul>
            {detail.batch.issues.map((i: any, n: number) => (
              <li key={n}>
                {i.severity} · 行 {i.row ?? "—"} · {i.field ?? ""} · {i.code}
              </li>
            ))}
          </ul>
          <p>以下为本次与当前版本的比较。NULL 表示未提供，不等于 0。</p>
          {detail.rows.map((r: any) => (
            <details key={r.id}>
              <summary>
                行 {r.rowNumber} · {r.uidMasked ?? "UID 无效"}
              </summary>
              <table>
                <thead>
                  <tr>
                    <th>字段</th>
                    <th>当前</th>
                    <th>本次</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(r.values).map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>{display(r.previousValues?.[k])}</td>
                      <td>{display(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {canImport && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      setRaw(
                        await request(
                          endpoint +
                            "/batches/" +
                            detail.batch.id +
                            "/evidence/" +
                            r.id,
                        ),
                      ),
                    )
                  }
                >
                  授权查看来源证据
                </button>
              )}
            </details>
          ))}
          {raw && (
            <details open>
              <summary>受控来源证据 · 行 {raw.row_number}</summary>
              <pre>{JSON.stringify(raw.raw_values, null, 2)}</pre>
              <button onClick={() => setRaw(undefined)}>关闭证据</button>
            </details>
          )}
          {canActivate &&
            ["ready", "review_required"].includes(detail.batch.status) && (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={confirm}
                    onChange={(e) => setConfirm(e.target.checked)}
                  />
                  我已核对业务日期、范围、完整性及差异，确认激活此批次
                </label>
                <button
                  disabled={busy || !confirm}
                  onClick={() =>
                    void run(async () => {
                      await request(
                        endpoint + "/batches/" + detail.batch.id + "/activate",
                        json(
                          {
                            approveChanges:
                              detail.batch.status === "review_required",
                          },
                          csrf,
                        ),
                      );
                      await open(detail.batch.id);
                      await load();
                    })
                  }
                >
                  确认 Activate
                </button>
              </>
            )}
        </section>
      )}
      <h3>当前用户日事实</h3>
      <table>
        <thead>
          <tr>
            <th>日期 / UID</th>
            <th>充值 / 提现 / 源充提差</th>
            <th>版本 / Telegram</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {facts.map((f) => (
            <tr key={f.id}>
              <td>
                {f.business_date} · {f.uidMasked}
              </td>
              <td>
                {display(f.deposit)} / {display(f.withdrawal)} /{" "}
                {display(f.source_net)}
              </td>
              <td>
                v{f.data_version} /{" "}
                {f.identity_id ? "已关联" : "未关联 Telegram"}
              </td>
              <td>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      setFact(await request(endpoint + "/facts/" + f.id)),
                    )
                  }
                >
                  事实与 Revision
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {fact && (
        <section aria-label="事实版本">
          <h3>事实与不可变 Revision</h3>
          {fact.revisions.map((r: any) => (
            <details key={r.id} open={r.current}>
              <summary>
                v{r.data_version} {r.current ? "当前" : "历史"} · {r.uidMasked}
              </summary>
              <p>
                batch {r.batch_id} · evidence {r.evidence_id} · {r.reason}
              </p>
              <details>
                <summary>Mapping 版本追溯</summary>
                <pre>{JSON.stringify(r.mapping_snapshot, null, 2)}</pre>
              </details>
              <dl>
                {Object.entries(r.values).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{display(v)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ))}
        </section>
      )}
      {offset > 0 && (
        <button
          disabled={busy}
          onClick={() => void run(() => load(Math.max(0, offset - 50)))}
        >
          上一页
        </button>
      )}
      {next !== null && (
        <button disabled={busy} onClick={() => void run(() => load(next))}>
          下一页
        </button>
      )}
      {busy && <p role="status">处理中…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
