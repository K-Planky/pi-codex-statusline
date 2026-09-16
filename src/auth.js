import { OPENAI_AUTH_CLAIM } from "./constants.js";

export function isCodexProvider(provider) {
  return /^openai-codex(?:-\d+)?$/.test(provider || "");
}

function decodeJwtPayload(token) {
  const payload = token.split(".")[1];
  if (!payload) return {};

  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

export function getAccountId(token) {
  const auth = decodeJwtPayload(token)[OPENAI_AUTH_CLAIM];
  return auth && typeof auth.chatgpt_account_id === "string"
    ? auth.chatgpt_account_id
    : undefined;
}
