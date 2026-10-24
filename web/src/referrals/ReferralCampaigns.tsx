import { useEffect, useRef, useState } from "react";
import { ApiError, json, request } from "../api";

type Platform = {
  id: string;
  code: string;
  display_name: string;
  timezone: string;
  status: string;
};
type Rule = {
  id: string;
  platform_id: string;
  campaign_key: string;
  version: number;
  status: "draft" | "published" | "disabled";
  effective_from: string;
  effective_until: string | null;
  inviter_points: string;
  invitee_points: string;
  invitee_enabled: boolean;
};
export type ReferralRulePreview = {
  platformId: string;
  platformName: string;
  timezone: string;
  campaignKey: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  inviterPoints: 50;
  inviteePoints: 20;
  inviteeEnabled: boolean;
  dailyQualifiedLimit: 5;
};

const statusText = { draft: "草稿", published: "已发布", disabled: "已停用" };

export default function ReferralCampaigns({
  brandBase,
  botBase,
  permissions,
  csrf,
  onExpire,
}: {
  brandBase: string;
  botBase: string;
  permissions: string[];
  csrf: string;
  onExpire: () => void;
}) {
  const canRead = permissions.includes("referrals.read");
  const canManage = permissions.includes("referrals.rules.manage");
  const canPublish = permissions.includes("referrals.rules.publish");
  const canPlatforms = permissions.includes("platforms.read");
  const [rules, setRules] = useState<Rule[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [preview, setPreview] = useState<ReferralRulePreview>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const live = useRef(true);
  const lock = useRef(false);

  function fail(value: unknown) {
    if (!live.current) return;
    if (value instanceof ApiError && value.status === 401) return onExpire();
    setError(value instanceof Error ? value.message : "请求失败，请重试");
  }
  async function load() {
    const [ruleData, platformData] = await Promise.all([
      request<{ items: Rule[] }>(brandBase + "/referral-rules"),
      canPlatforms
        ? request<{ items: Platform[] }>(botBase + "/platforms")
        : Promise.resolve({ items: [] as Platform[] }),
    ]);
    if (!live.current) return;
    setRules(ruleData.items);
    setPlatforms(platformData.items.filter((p) => p.status === "active"));
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (value) {
      fail(value);
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  }
  useEffect(() => {
    live.current = true;
    if (canRead) void run(load);
    return () => {
      live.current = false;
    };
  }, [brandBase, botBase, canRead, canPlatforms]);

  if (!canRead)
    return <section className="empty">你没有查看邀请活动的权限。</section>;

  function previewForm(form: HTMLFormElement) {
    const data = new FormData(form);
    const platform = platforms.find((p) => p.id === data.get("platformId"));
    const campaignKey = String(data.get("campaignKey") ?? "").trim();
    const effectiveFrom = String(data.get("effectiveFrom") ?? "");
    const permanent = data.get("permanent") === "on";
    const effectiveUntil = permanent
      ? null
      : String(data.get("effectiveUntil") ?? "");
    if (!platform || !campaignKey || !effectiveFrom) {
      setError("请完整填写平台、活动标识和开始日期。");
      return;
    }
    if (!permanent && !effectiveUntil) {
      setError("请选择结束日期，或勾选长期有效。");
      return;
    }
    if (effectiveUntil && effectiveUntil < effectiveFrom) {
      setError("结束日期不能早于开始日期。");
      return;
    }
    setError("");
    setPreview({
      platformId: platform.id,
      platformName: `${platform.display_name} (${platform.code})`,
      timezone: platform.timezone,
      campaignKey,
      effectiveFrom,
      effectiveUntil,
      inviterPoints: 50,
      inviteePoints: 20,
      inviteeEnabled: data.get("inviteeEnabled") === "on",
      dailyQualifiedLimit: 5,
    });
  }
  async function createDraft() {
    if (!preview) return;
    await run(async () => {
      await request(
        brandBase + "/referral-rules",
        json(
          {
            platformId: preview.platformId,
            campaignKey: preview.campaignKey,
            effectiveFrom: preview.effectiveFrom,
            effectiveUntil: preview.effectiveUntil,
            inviteeEnabled: preview.inviteeEnabled,
          },
          csrf,
        ),
      );
      if (live.current) {
        setPreview(undefined);
        setOpen(false);
        setNotice("邀请活动草稿已创建，请核对后再发布。");
      }
      await load();
    });
  }
  async function changeRule(id: string, action: "publish" | "disable") {
    const confirmed = window.confirm(
      action === "publish"
        ? "确认发布该邀请活动？发布后规则内容不可修改。"
        : "确认停用该邀请活动？已形成的历史奖励不会自动撤销。",
    );
    if (!confirmed) return;
    await run(async () => {
      await request(
        brandBase + `/referral-rules/${id}/${action}`,
        json({}, csrf),
      );
      if (live.current)
        setNotice(
          action === "publish" ? "邀请活动已发布。" : "邀请活动已停用。",
        );
      await load();
    });
  }
  const platformName = (id: string) => {
    const platform = platforms.find((p) => p.id === id);
    return platform
      ? `${platform.display_name} (${platform.code})`
      : `Platform ${id.slice(0, 8)}`;
  };

  return (
    <section className="panel referral-campaigns">
      <div className="table-title">
        <div>
          <h2>邀请活动</h2>
          <p className="muted">
            邀请人固定获得 50 Points；每天每个平台最多奖励 5 个合格邀请。
          </p>
        </div>
        <span>
          {canManage && canPlatforms && (
            <button disabled={busy} onClick={() => setOpen(true)}>
              新建邀请活动
            </button>
          )}{" "}
          <button disabled={busy} onClick={() => void run(load)}>
            刷新
          </button>
        </span>
      </div>
      {busy && <p role="status">正在加载…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!rules.length ? (
        <p className="empty">暂无邀请活动。</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>平台</th>
                <th>活动</th>
                <th>奖励</th>
                <th>有效窗口</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td>{platformName(rule.platform_id)}</td>
                  <td>
                    <strong>{rule.campaign_key}</strong>
                    <small>V{rule.version}</small>
                  </td>
                  <td>
                    邀请人 {rule.inviter_points} Points
                    <small>
                      被邀请人：
                      {rule.invitee_enabled
                        ? `${rule.invitee_points} Points`
                        : "关闭"}
                    </small>
                  </td>
                  <td>
                    {rule.effective_from} → {rule.effective_until ?? "长期有效"}
                  </td>
                  <td>{statusText[rule.status]}</td>
                  <td>
                    {rule.status === "draft" && canPublish && (
                      <button
                        disabled={busy}
                        onClick={() => void changeRule(rule.id, "publish")}
                      >
                        发布
                      </button>
                    )}
                    {rule.status === "published" && canManage && (
                      <button
                        disabled={busy}
                        onClick={() => void changeRule(rule.id, "disable")}
                      >
                        停用
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canManage && !canPlatforms && (
        <p className="muted">需要平台查看权限后才能创建邀请活动。</p>
      )}

      {open && (
        <div className="detail-overlay">
          <section
            className="detail"
            role="dialog"
            aria-modal="true"
            aria-label="新建邀请活动"
          >
            <div className="table-title">
              <h2>新建邀请活动</h2>
              <button
                onClick={() => {
                  setOpen(false);
                  setPreview(undefined);
                }}
              >
                关闭
              </button>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                previewForm(event.currentTarget);
              }}
            >
              <label>
                平台
                <select name="platformId" required defaultValue="">
                  <option value="" disabled>
                    请选择平台
                  </option>
                  {platforms.map((platform) => (
                    <option key={platform.id} value={platform.id}>
                      {platform.display_name} ({platform.code})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                活动标识
                <input name="campaignKey" maxLength={120} required />
              </label>
              <label>
                开始日期
                <input name="effectiveFrom" type="date" required />
              </label>
              <label>
                结束日期
                <input name="effectiveUntil" type="date" />
              </label>
              <label className="check-row">
                <input name="permanent" type="checkbox" /> 长期有效
              </label>
              <label className="check-row">
                <input name="inviteeEnabled" type="checkbox" />
                合格后同时奖励被邀请人 20 Points
              </label>
              <div className="confirm">
                <p>邀请人奖励固定为 50 Points，不能在页面修改。</p>
                <p>每日上限按合格邀请人数计数，不按积分流水笔数计数。</p>
              </div>
              <button className="primary" disabled={busy}>
                预览
              </button>
            </form>
            {preview && (
              <div className="confirm" data-testid="referral-rule-preview">
                <h3>发布前预览</h3>
                <p>
                  {preview.platformName} · {preview.timezone}
                </p>
                <p>
                  {preview.effectiveFrom} →{" "}
                  {preview.effectiveUntil ?? "长期有效"}
                </p>
                <p>
                  邀请人 50 Points · 被邀请人
                  {preview.inviteeEnabled ? " 20 Points" : "不奖励"}
                </p>
                <button disabled={busy} onClick={() => void createDraft()}>
                  创建草稿
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
