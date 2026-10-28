import { useEffect, useRef, useState } from "react";
import { ApiError, json, request } from "../api";
import "./operations.css";

export type ContentLanguage = "zh-CN" | "en" | "pt-BR" | "es-MX" | "fil";
export type ContentCopy = {
  newUser: string;
  returningUser: string;
  openLabel: string;
  inviteLabel: string;
  supportLabel: string;
};
export type ContentConfig = {
  locales: Record<ContentLanguage, ContentCopy>;
  supportUrl: string | null;
};
export type ContentState = {
  draft: ContentConfig;
  draftVersion: number;
  published: ContentConfig | null;
  publishedVersion: number;
  enabled: boolean;
  miniUrl: string | null;
};
type Preview = {
  text: string;
  buttons: Array<{ text: string; url?: string; web_app?: { url: string } }>;
  deliveryConfirmed: false;
};
type Props = {
  base: string;
  permissions: string[];
  csrf: string;
  onExpire: () => void;
};
const languages: Array<[ContentLanguage, string]> = [
  ["zh-CN", "中文"],
  ["en", "English"],
  ["pt-BR", "Português (Brasil)"],
  ["es-MX", "Español (México)"],
  ["fil", "Filipino"],
];

export default function BotContent(props: Props) {
  if (!props.permissions.includes("messages.publish"))
    return <section className="empty">你没有管理 Bot 内容的权限。</section>;
  return <ContentEditor key={props.base} {...props} />;
}

function ContentEditor({ base, csrf, onExpire }: Props) {
  const [state, setState] = useState<ContentState>();
  const [config, setConfig] = useState<ContentConfig>();
  const [language, setLanguage] = useState<ContentLanguage>("zh-CN");
  const [audience, setAudience] = useState<"new" | "returning">("new");
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const live = useRef(true);
  const lock = useRef(false);
  const dirty =
    !!state && JSON.stringify(config) !== JSON.stringify(state.draft);
  const root = base + "/operations/content";
  function accept(value: ContentState) {
    setState(value);
    setConfig(value.draft);
    setPreview(undefined);
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
      if (!live.current) return;
      if (value instanceof ApiError && value.status === 401) onExpire();
      else
        setError(
          value instanceof ApiError ? value.message : "请求失败，请重试。",
        );
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function load() {
    const result = await request<ContentState>(root);
    if (live.current) accept(result);
  }
  useEffect(() => {
    live.current = true;
    void run(load);
    return () => {
      live.current = false;
    };
  }, []);
  function edit(field: keyof ContentCopy, value: string) {
    if (!config) return;
    setConfig({
      ...config,
      locales: {
        ...config.locales,
        [language]: { ...config.locales[language], [field]: value },
      },
    });
    setPreview(undefined);
    setNotice("");
  }
  async function save() {
    const result = await request<ContentState>(
      root + "/draft",
      json({ config, expectedVersion: state!.draftVersion }, csrf),
    );
    if (live.current) {
      accept(result);
      setNotice("草稿已保存，请预览后发布。");
    }
  }
  async function showPreview() {
    const result = await request<Preview>(
      root + "/preview",
      json({ config, language, audience }, csrf),
    );
    if (live.current) setPreview(result);
  }
  async function publish() {
    if (
      dirty ||
      !state?.draftVersion ||
      !preview ||
      !state ||
      !window.confirm("确认发布当前已保存的 Bot 欢迎内容？不会立即群发消息。")
    )
      return;
    const result = await request<ContentState>(
      root + "/publish",
      json({ expectedVersion: state.draftVersion }, csrf),
    );
    if (live.current) {
      accept(result);
      setNotice("内容已发布。请用测试账号从 Bot 进入验证实际显示。");
    }
  }
  async function disable() {
    if (!state || !window.confirm("确认停用当前 Bot 欢迎内容？")) return;
    const result = await request<ContentState>(
      root + "/disable",
      json({ expectedVersion: state.publishedVersion }, csrf),
    );
    if (live.current) {
      accept(result);
      setNotice("内容已停用。");
    }
  }
  return (
    <section className="panel bot-content">
      <div className="table-title">
        <div>
          <h2>Bot 欢迎内容</h2>
          <p className="muted">
            新老用户欢迎语和三个入口，按当前 Bot 独立发布。
          </p>
        </div>
        <button
          disabled={busy}
          onClick={() => {
            if (!dirty || window.confirm("刷新会放弃未保存的修改，继续？"))
              void run(load);
          }}
        >
          刷新
        </button>
      </div>
      {busy && <p role="status">正在处理…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {state && config && (
        <>
          <p>
            状态：{state.enabled ? "已发布" : "未启用"} · 草稿 V
            {state.draftVersion} · 发布 V{state.publishedVersion}
          </p>
          {!state.miniUrl && (
            <p role="alert">
              当前 Bot 的 Mini 入口尚未配置，发布前请联系管理员。
            </p>
          )}
          <div className="bot-content-layout">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(save);
              }}
            >
              <fieldset disabled={busy}>
                <legend>欢迎内容</legend>
                <label>
                  内容语言
                  <select
                    value={language}
                    onChange={(e) => {
                      setLanguage(e.target.value as ContentLanguage);
                      setPreview(undefined);
                    }}
                  >
                    {languages.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  新用户欢迎语
                  <textarea
                    required
                    maxLength={700}
                    value={config.locales[language].newUser}
                    onChange={(e) => edit("newUser", e.target.value)}
                  />
                </label>
                <label>
                  老用户欢迎语
                  <textarea
                    required
                    maxLength={700}
                    value={config.locales[language].returningUser}
                    onChange={(e) => edit("returningUser", e.target.value)}
                  />
                </label>
                {(
                  [
                    ["openLabel", "主按钮文案"],
                    ["inviteLabel", "邀请入口文案"],
                    ["supportLabel", "客服入口文案"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      required
                      maxLength={60}
                      value={config.locales[language][key]}
                      onChange={(e) => edit(key, e.target.value)}
                    />
                  </label>
                ))}
                <label>
                  客服 Telegram 地址（选填）
                  <input
                    type="url"
                    placeholder="https://t.me/support"
                    value={config.supportUrl ?? ""}
                    onChange={(e) => {
                      setConfig({
                        ...config,
                        supportUrl: e.target.value || null,
                      });
                      setPreview(undefined);
                      setNotice("");
                    }}
                  />
                </label>
                <p className="muted">
                  不填客服地址时隐藏客服按钮。主入口及邀请地址由服务端根据当前
                  Bot 生成。
                </p>
                <button
                  type="submit"
                  disabled={!dirty && state.draftVersion > 0}
                >
                  保存草稿
                </button>
                <label>
                  预览用户
                  <select
                    value={audience}
                    onChange={(e) => {
                      setAudience(e.target.value as "new" | "returning");
                      setPreview(undefined);
                    }}
                  >
                    <option value="new">新用户</option>
                    <option value="returning">老用户</option>
                  </select>
                </label>
                <button type="button" onClick={() => void run(showPreview)}>
                  手机预览
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={
                    dirty || !state.draftVersion || !preview || !state.miniUrl
                  }
                  onClick={() => void run(publish)}
                >
                  发布内容
                </button>
                <button
                  type="button"
                  disabled={!state.enabled}
                  onClick={() => void run(disable)}
                >
                  停用内容
                </button>
              </fieldset>
              {dirty && (
                <p className="muted">有未保存修改，保存并预览后才能发布。</p>
              )}
            </form>
            <aside>
              <div className="bot-phone-preview" aria-label="手机预览">
                <strong>Telegram Bot</strong>
                {preview ? (
                  <>
                    <p className="bot-preview-text">{preview.text}</p>
                    {preview.buttons.map((button, index) => (
                      <div className="bot-preview-button" key={index}>
                        {button.text}
                      </div>
                    ))}
                  </>
                ) : (
                  <p>点击手机预览查看当前语言和用户类型的内容。</p>
                )}
              </div>
              <p className="muted">
                预览不发送 Telegram 消息，也不能确认实际送达。
              </p>
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
