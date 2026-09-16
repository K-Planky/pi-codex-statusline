import { OPENAI_AUTH_CLAIM } from "./constants.ts";

export function isCodexProvider(provider: string | undefined): boolean {
  return /^openai-codex(?:-\d+)?$/.test(provider || "");
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) return {};

  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function getAccountId(token: string): string | undefined {
  const auth = decodeJwtPayload(token)[OPENAI_AUTH_CLAIM];
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return undefined;
  return "chatgpt_account_id" in auth && typeof auth.chatgpt_account_id === "string"
    ? auth.chatgpt_account_id
    : undefined;
}
