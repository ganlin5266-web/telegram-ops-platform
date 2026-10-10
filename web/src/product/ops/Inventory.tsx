// 积分 → 兑换 (Reward Catalog) and 积分 → 兑换码库存 (Code Inventory).
// Inventory belongs to Market + Platform; never to Bot/Channel. Stock state,
// duplicate/invalid validation, assignment and Points deduction are backend-only.
// This is NOT the Platform business-data upload (设置 → 数据接入).
import { useState } from "react";
import { fmt } from "./model";
import {
  blockingChecks,
  importBlocked,
  importCheckKeys,
  importCheckText,
  inventoryFor,
  restockTemplate,
  standardTemplate,
  stockText,
  type CodeBatch,
  type ImportPreview,
  type PlatformStock,
  type Reward,
} from "./market";

const cell = (v: string) => fmt({ s: "value", v });
const face = (r: Reward) =>
  r.faceValue && r.currency ? `${r.faceValue} ${r.currency}` : "待接入";

const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** UI template only: keep contract headers in English and include one replaceable example row. */
export function templateCsv(
  cols: readonly string[],
  example: readonly string[],
) {
  return `\uFEFF${cols.map(csvCell).join(",")}\n${example.map(csvCell).join(",")}\n`;
}

function downloadTemplate(
  cols: readonly string[],
  example: readonly string[],
  name: string,
) {
  const url = URL.createObjectURL(
    new Blob([templateCsv(cols, example)], { type: "text/csv;charset=utf-8" }),
  );
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: name,
  });
  a.click();
  URL.revokeObjectURL(url);
}

export function RewardCatalog({
  rewards,
  market,
  platform,
  platformName,
  preview,
}: {
  rewards: Reward[];
  market: string;
  platform: string;
  platformName?: string;
  preview?: boolean;
}) {
  const [add, setAdd] = useState(false);
  const rows = rewards.filter(
    (r) => r.market === market && (!platform || r.platform === platform),
  );
  return (
    <section className="ops-panel" aria-label="奖励目录">
      <div className="ops-panel-head">
        <h2>奖励目录 · {platformName ?? "全部平台"}</h2>
        {preview && (
          <button className="ops-primary" onClick={() => setAdd(true)}>
            + 新增奖励
          </button>
        )}
      </div>
      {!rows.length ? (
        <p className="ops-empty">当前范围暂无奖励配置</p>
      ) : (
        <div className="ops-scroll">
          <table className="ops-table mk-table">
            <thead>
              <tr>
                <th>平台</th>
                <th>奖励</th>
                <th>面额</th>
                <th>币种</th>
                <th>积分成本</th>
                <th>状态</th>
                <th>库存</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.platform}</td>
                  <td>
                    <b>{r.label}</b>
                  </td>
                  <td>{r.faceValue ?? "待接入"}</td>
                  <td>{r.currency ?? "待接入"}</td>
                  <td>{r.cost ? `${cell(r.cost)} 积分` : "待接入"}</td>
                  <td>
                    <span className={`mk-pill mk-${r.status ?? "active"}`}>
                      {r.status === "disabled" ? "已停用" : "启用"}
                    </span>
                  </td>
                  <td>
                    {r.stock ? (
                      <span className={`mk-pill mk-s-${r.stock}`}>
                        {stockText[r.stock]}
                      </span>
                    ) : (
                      "待接入"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="ops-muted small">
        面额与积分成本分开保存；面额不等于公司成本。已停用奖励不产生新兑换，历史兑换继续显示。修改已有兑换历史的积分成本需后端版本规则（待架构确认）。
      </p>
      {add && (
        <div className="ops-modal" role="dialog" aria-label="新增奖励">
          <div className="mk-form">
            <h3>新增奖励</h3>
            <p className="mk-final">
              国家：<b>{market}</b> · 平台：
              <b>{platformName ?? (platform || "请先在顶部选择平台")}</b>
            </p>
            <label>
              面额
              <input inputMode="decimal" placeholder="例如 5" />
            </label>
            <label>
              币种
              <input placeholder="例如 BRL" />
            </label>
            <label>
              积分成本
              <input inputMode="numeric" placeholder="例如 450" />
            </label>
            <p className="mk-note">
              奖励目录写入待接入（BACKEND_PENDING）；预览环境不保存。
            </p>
            <div className="mk-actions">
              <button className="ops-ghost" onClick={() => setAdd(false)}>
                关闭
              </button>
              <button className="ops-primary" disabled>
                保存（待接入）
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

type Upload = { mode: "restock"; reward: Reward } | { mode: "batch" };

/** PREVIEW-only precheck results (backend-produced in production). */
const previewRestock: ImportPreview = {
  total: 1000,
  importable: 986,
  dupInFile: 6,
  dupInStock: 3,
  dupAssigned: 1,
  invalidCode: 4,
};
const previewBatch: ImportPreview = {
  total: 1000,
  importable: 971,
  dupInFile: 8,
  dupInStock: 6,
  dupAssigned: 3,
  invalidCode: 4,
  rewardMissing: 5,
  costMismatch: 2,
  currencyMismatch: 1,
};
const previewIssueRows = (batch: boolean): [number, string][] => [
  [12, "非法兑换码：空值"],
  [87, "非法兑换码：非法字符"],
  [301, "文件内重复：ABC001"],
  ...(batch
    ? ([
        [
          415,
          "未找到对应奖励：FUN66 · 5 BRL · 500 积分（需先创建奖励或由管理员确认）",
        ],
        [502, "积分成本与现有奖励不一致：FUN66 R$2 现有 200，模板 250"],
      ] as [number, string][])
    : []),
];

const batchText: Record<CodeBatch["status"], string> = {
  done: "已完成",
  rejected: "已拒绝",
  processing: "处理中",
};

function Batches({ batches }: { batches?: CodeBatch[] }) {
  return (
    <section className="ops-panel" aria-label="导入记录">
      <div className="ops-panel-head">
        <h2>导入记录</h2>
      </div>
      {!batches ? (
        <p className="ops-pending-note">导入记录待接入（BACKEND_PENDING）。</p>
      ) : !batches.length ? (
        <p className="ops-empty">暂无导入记录</p>
      ) : (
        <div className="ops-scroll">
          <table className="ops-table mk-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>平台</th>
                <th>奖励</th>
                <th className="mk-hide-md">文件</th>
                <th>总数</th>
                <th>成功</th>
                <th>拒绝</th>
                <th className="mk-hide-md">操作人</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>{b.at}</td>
                  <td>{b.platform}</td>
                  <td>{b.reward}</td>
                  <td className="mk-hide-md">{b.file}</td>
                  <td>{b.total}</td>
                  <td>{b.ok}</td>
                  <td>{b.rejected}</td>
                  <td className="mk-hide-md">{b.operator}</td>
                  <td>{batchText[b.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="ops-muted small">
        完整兑换码不在库存页展示；查看需进入批次详情并受权限控制（BACKEND_PENDING）。
      </p>
    </section>
  );
}

export function Inventory({
  rewards,
  market,
  platform,
  platformName,
  preview,
  summary,
  batches,
  onPlatform,
}: {
  rewards: Reward[];
  market: string;
  platform: string;
  platformName?: string;
  preview?: boolean;
  summary?: PlatformStock[];
  batches?: CodeBatch[];
  onPlatform?: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [up, setUp] = useState<Upload | null>(null);
  const [picked, setPicked] = useState(false);
  const [issues, setIssues] = useState(false);
  const open = (u: Upload) => {
    setUp(u);
    setPicked(false);
    setIssues(false);
  };
  const head = (title: string) => (
    <div className="ops-panel-head">
      <h2>{title}</h2>
      <span className="mk-row-actions">
        <button className="ops-ghost" onClick={() => open({ mode: "batch" })}>
          批量导入兑换码
        </button>
      </span>
    </div>
  );
  const pn = platformName ?? platform;
  const rows = platform
    ? inventoryFor(rewards, market, platform).filter(
        (r) => !q || r.label.toLowerCase().includes(q.toLowerCase()),
      )
    : [];
  const cols =
    up?.mode === "restock"
      ? restockTemplate({ market, platform, reward: up.reward.id })
      : standardTemplate;
  const pv = up?.mode === "restock" ? previewRestock : previewBatch;
  const blocked = importBlocked(pv);
  const shown = importCheckKeys.filter((k) => pv[k] != null);
  return (
    <>
      {!platform ? (
        <section className="ops-panel" aria-label="平台库存摘要">
          {head("兑换码库存 · 全部平台")}
          {!summary ? (
            <p className="ops-pending-note">
              平台库存摘要待接入（BACKEND_PENDING）。
            </p>
          ) : !summary.length ? (
            <p className="ops-empty">当前国家暂无奖励库存</p>
          ) : (
            <div className="ops-scroll">
              <table className="ops-table mk-table">
                <thead>
                  <tr>
                    <th>平台</th>
                    <th>奖励数量</th>
                    <th>可用兑换码</th>
                    <th>低库存</th>
                    <th>缺货</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {summary.map((s) => (
                    <tr key={s.platform}>
                      <td>
                        <b>{s.platform}</b>
                      </td>
                      <td>{s.rewards} 个奖励</td>
                      <td>{s.available}</td>
                      <td>
                        {s.low ? (
                          <span className="mk-pill mk-s-low">
                            {s.low} 个低库存
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {s.out ? (
                          <span className="mk-pill mk-s-out">
                            {s.out} 个缺货
                          </span>
                        ) : s.low ? (
                          "—"
                        ) : (
                          <span className="mk-pill mk-s-ok">正常</span>
                        )}
                      </td>
                      <td>
                        {onPlatform && (
                          <button
                            className="ops-link"
                            onClick={() => onPlatform(s.platform)}
                          >
                            查看详情
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="ops-muted small">
            补充单个奖励的库存请先进入具体平台。库存状态与阈值由后端决定。
          </p>
        </section>
      ) : (
        <section className="ops-panel" aria-label="兑换码库存">
          {head(`兑换码库存 · ${market} / ${pn}`)}
          <div className="ops-filter flat">
            <input
              className="ops-search"
              aria-label="搜索奖励"
              placeholder="搜索奖励 / 面额"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {!rows.length ? (
            <p className="ops-empty">该平台暂无奖励库存</p>
          ) : (
            <div className="ops-scroll">
              <table className="ops-table mk-table">
                <thead>
                  <tr>
                    <th>奖励</th>
                    <th className="mk-hide-md">面额</th>
                    <th className="mk-hide-md">币种</th>
                    <th>积分成本</th>
                    <th>可用库存</th>
                    <th className="mk-hide-md">已分配</th>
                    <th>库存状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <b>{r.label}</b>
                        {r.status === "disabled" && (
                          <small className="ops-muted"> · 已停用</small>
                        )}
                      </td>
                      <td className="mk-hide-md">{face(r)}</td>
                      <td className="mk-hide-md">{r.currency ?? "待接入"}</td>
                      <td>{r.cost ? `${cell(r.cost)} 积分` : "待接入"}</td>
                      <td>{cell(r.available)}</td>
                      <td className="mk-hide-md">{cell(r.assigned)}</td>
                      <td>
                        {r.stock ? (
                          <span className={`mk-pill mk-s-${r.stock}`}>
                            {stockText[r.stock]}
                          </span>
                        ) : (
                          <span className="ops-muted">待接入</span>
                        )}
                      </td>
                      <td>
                        <button
                          className="ops-link"
                          disabled={r.status === "disabled"}
                          onClick={() => open({ mode: "restock", reward: r })}
                        >
                          补充库存
                        </button>{" "}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="ops-muted small">
            完整兑换码默认不展示。库存阈值由后端/配置决定。已分配的兑换码不会回到可用库存；不提供一键回滚。上传模板只能补库存，不能修改积分成本、币种或奖励状态——请在「兑换
            → 奖励目录」管理。
          </p>
        </section>
      )}
      <Batches batches={batches} />
      {up && (
        <div
          className="ops-modal"
          role="dialog"
          aria-label={up.mode === "restock" ? "补充库存" : "批量导入兑换码"}
        >
          <div className="mk-form">
            <h3>{up.mode === "restock" ? "补充库存" : "批量导入兑换码"}</h3>
            {up.mode === "restock" ? (
              <p className="mk-final">
                {market} · <b>{pn}</b> · <b>{up.reward.label}</b> ·{" "}
                {up.reward.currency ?? "—"} · {up.reward.cost ?? "—"} 积分
                <br />
                <small>
                  文件只需要一列“兑换码”，平台、面额、币种和积分成本由奖励配置自动带出。
                </small>
              </p>
            ) : (
              <p className="mk-final">
                国家：<b>{market}</b>（由当前入口确定，无需填写国家代码）
                <br />
                标准模板可一次处理多个平台和奖励。
                <br />
                <small>
                  字段依次为：平台代码、奖励面额、币种、积分成本、兑换码。系统按这些信息匹配已有奖励，不会自动创建或修改奖励。跨国家批量导入需使用额外包含国家代码的高级模板。
                </small>
              </p>
            )}
            <button
              className="ops-link"
              onClick={() =>
                downloadTemplate(
                  cols,
                  up.mode === "restock"
                    ? ["EXAMPLE_CODE_001"]
                    : [
                        platform || "FUN66",
                        up.mode === "batch" ? "5" : "",
                        up.mode === "batch" ? "BRL" : "",
                        up.mode === "batch" ? "500" : "",
                        "EXAMPLE_CODE_001",
                      ],
                  up.mode === "restock"
                    ? `${platform}_${up.reward.id}_codes.csv`
                    : "兑换码批量导入标准模板.csv",
                )
              }
            >
              {up.mode === "restock" ? "下载补码模板" : "下载标准模板"}
            </button>
            <p className="ops-muted small">
              模板已包含一行示例；上传前请替换或删除示例数据。模板内的英文字段名为系统识别字段，请勿修改。
            </p>
            <label>
              兑换码文件（CSV / XLSX）
              <input
                type="file"
                accept=".csv,.xlsx"
                onChange={() => setPicked(true)}
              />
            </label>
            {preview && !picked && (
              <button className="ops-ghost" onClick={() => setPicked(true)}>
                模拟选择文件（预览）
              </button>
            )}
            {preview && picked && (
              <>
                <dl className="ops-dl" aria-label="上传预检（模拟）">
                  {shown.map((k) => (
                    <div key={k}>
                      <dt>{importCheckText[k]}</dt>
                      <dd
                        className={
                          blockingChecks.includes(k) ? "mk-block" : undefined
                        }
                      >
                        {new Intl.NumberFormat("zh-CN").format(pv[k] ?? 0)}
                        {blockingChecks.includes(k) ? "（阻断）" : ""}
                      </dd>
                    </div>
                  ))}
                </dl>
                <button className="ops-link" onClick={() => setIssues(!issues)}>
                  {issues ? "收起" : "查看问题行"}
                </button>
                {issues && (
                  <div className="ops-scroll">
                    <table className="ops-table" aria-label="问题行（模拟）">
                      <thead>
                        <tr>
                          <th>行</th>
                          <th>问题</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewIssueRows(up.mode === "batch").map(([n, t]) => (
                          <tr key={n}>
                            <td>{n}</td>
                            <td style={{ whiteSpace: "normal" }}>{t}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {blocked.length > 0 && (
                  <p className="mk-note mk-block" role="alert">
                    存在阻断问题（
                    {blocked.map((k) => importCheckText[k]).join("、")}
                    ），确认导入不可用。请先在奖励目录创建或核对奖励，或联系管理员。
                  </p>
                )}
              </>
            )}
            <p className="mk-note">
              上传后先预检，不立即入库。重复、合法性、奖励匹配、可跳过规则、事务与审计由后端负责（BACKEND_PENDING）。
              {preview ? " 以上预检为预览模拟。" : ""}
            </p>
            <div className="mk-actions">
              <button className="ops-ghost" onClick={() => setUp(null)}>
                关闭
              </button>
              <button className="ops-primary" disabled>
                {blocked.length && picked
                  ? "确认导入（存在阻断问题）"
                  : "确认导入（待接入）"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
