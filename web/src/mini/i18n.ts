import type { Failure } from "./client";
// UI locale is independent of Telegram message fallback. Only zh-CN is shipped in P2.
export const supportedUiLocales = ["zh-CN"] as const;
export const plannedUiLocales = ["pt-BR", "es-MX", "fil-PH", "en"] as const;
export const messages: Record<Failure, string> = {
  network: "连接暂时中断，请检查网络后重试。",
  timeout: "服务响应较慢，请稍后重试。",
  invalid_json: "服务暂时无法读取，请稍后重试。",
  unauthorized: "身份已失效，请关闭并重新打开小程序。",
  forbidden: "当前操作不可用，请稍后重试。",
  not_found: "内容暂不可用。",
  conflict: "状态已变化，请重新读取。",
  rate_limit: "操作较频繁，请稍后再试。",
  server: "服务暂时繁忙，请稍后重试。",
  request: "暂时无法完成，请稍后重试。",
  telegram_required: "请从 FUN_Club_Staging_bot 的小程序入口打开。",
};
