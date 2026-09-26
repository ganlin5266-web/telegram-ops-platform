import {
  createMiniTestClient,
  MiniTestError,
  type MiniIdentity,
} from "./client";
import "./style.css";
declare global {
  interface Window {
    Telegram?: { WebApp?: { initData?: string; ready?: () => void } };
  }
}
const client = createMiniTestClient();
const element = (id: string) => document.getElementById(id)!;
const button = (id: string) => element(id) as HTMLButtonElement;
let running = false;
const clear = () => {
  for (const id of ["user", "brand", "bot", "expiry"])
    element(id).textContent = "—";
};
function controls() {
  button("connect").disabled = running || client.attempted;
  button("me").disabled = running || !client.connected;
  button("logout").disabled = running || !client.connected;
}
function identity(data: MiniIdentity) {
  element("user").textContent =
    `${data.userId.slice(0, 4)}…${data.userId.slice(-4)}`;
  element("brand").textContent = data.brandId;
  element("bot").textContent = data.botId;
  element("expiry").textContent = data.expiresAt;
  element("status").textContent = "Session 已认证（服务端 /me 验证成功）";
}
async function run(action: () => Promise<void>) {
  if (running) return;
  running = true;
  controls();
  try {
    await action();
  } catch (e) {
    const code = e instanceof MiniTestError ? e.code : "request_failed";
    element("status").textContent =
      `未完成：${code}。不自动重试；请关闭并重新打开 Mini App。`;
    if (!client.connected) clear();
  } finally {
    running = false;
    controls();
  }
}
button("connect").onclick = () =>
  void run(async () =>
    identity(await client.connect(window.Telegram?.WebApp?.initData ?? "")),
  );
button("me").onclick = () => void run(async () => identity(await client.me()));
button("logout").onclick = () =>
  void run(async () => {
    await client.logout();
    clear();
    element("status").textContent = "已退出；撤销后的 /me 返回 401。";
  });
window.addEventListener("pagehide", () => {
  client.forget();
  clear();
  element("status").textContent =
    "Session 已从页面内存清除，请重新打开 Mini App。";
  controls();
});
window.Telegram?.WebApp?.ready?.();
controls();
