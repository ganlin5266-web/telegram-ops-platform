export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string = "",
  ) {
    super(message(status, code));
  }
}
export function message(status: number, code = ""): string {
  if (code === "invalid_credentials") return "登录信息错误或账号不可用";
  if (code === "csrf_failed") return "安全验证已失效，请重新登录后操作";
  if (["origin_not_allowed", "origin_required", "cors_denied"].includes(code))
    return "后台来源配置错误，请联系管理员";
  return (
    (
      {
        0: "网络连接失败，请检查网络后重试",
        400: "请求参数无效，请检查输入",
        401: "登录已过期，请重新登录",
        403: "你没有权限执行此操作",
        404: "数据不存在或已不可访问",
        409: "操作冲突，请刷新后重试",
        429: "操作过于频繁，请稍后再试",
        500: "系统异常，请稍后重试",
      } as Record<number, string>
    )[status] || "系统异常，请稍后重试"
  );
}
export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(
      `${import.meta.env.VITE_API_BASE || ""}${path}`,
      {
        ...options,
        signal: controller.signal,
        credentials: "include",
        cache: "no-store",
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new ApiError(
        response.status,
        typeof body.error === "string" ? body.error : "",
      );
    }
    return response.status === 204 ? (undefined as T) : await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0);
  } finally {
    clearTimeout(timer);
  }
}
export function json(body: unknown, csrf?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : { "X-CSRF-Protection": "1" }),
    },
    body: JSON.stringify(body),
  };
}
export function operation(
  userId: string,
  delta: string,
  reason: string,
  remarks: string,
) {
  const note = `原因：${reason.trim()}${remarks.trim() ? `\n备注：${remarks.trim()}` : ""}`;
  if (
    !/^-?[1-9][0-9]*$/.test(delta) ||
    delta.length > 20 ||
    BigInt(delta) === 0n ||
    !reason.trim() ||
    note.length > 500
  )
    throw new Error("请输入非零整数和原因，原因及备注合计不超过 500 字符");
  return {
    key: crypto.randomUUID(),
    body: { userId, delta, eventId: crypto.randomUUID(), note },
  };
}
export type Operation = ReturnType<typeof operation>;
