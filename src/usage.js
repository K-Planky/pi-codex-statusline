import { getAccountId, isCodexProvider } from "./auth.js";
import {
  FIVE_HOUR_SECONDS,
  USAGE_URL,
  WEEK_SECONDS,
} from "./constants.js";

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function normalizeUsageWindow(value) {
  const record = asRecord(value);
  if (!record) return undefined;

  const usedPercent = finiteNumber(record.used_percent);
  const windowSeconds = finiteNumber(record.limit_window_seconds);
  const resetAt = finiteNumber(record.reset_at);
  if (usedPercent === undefined || windowSeconds === undefined) return undefined;

  return { usedPercent, windowSeconds, resetAt };
}

export function parseUsageResponse(data) {
  const payload = asRecord(data);
  const rateLimit = asRecord(payload?.rate_limit);
  const windows = [
    normalizeUsageWindow(rateLimit?.primary_window),
    normalizeUsageWindow(rateLimit?.secondary_window),
  ].filter(Boolean);

  return {
    fiveHour: windows.find(
      (window) =>
        Math.abs(window.windowSeconds - FIVE_HOUR_SECONDS) <= 120,
    ),
    weekly: windows.find(
      (window) => Math.abs(window.windowSeconds - WEEK_SECONDS) <= 120,
    ),
  };
}

// Pi's credential resolver has no AbortSignal parameter. Stop waiting when
// cancelled, while still observing a late resolution/rejection of its promise.
async function waitForAuth(promise, signal) {
  if (!signal) return promise;

  let onAbort;
  const cancelled = new Promise((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const auth = await Promise.race([promise, cancelled]);
    signal.throwIfAborted();
    return auth;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function fetchCodexUsage(
  ctx,
  { signal, fetchImpl = globalThis.fetch, endpoint = USAGE_URL } = {},
) {
  signal?.throwIfAborted();
  const model = ctx.model;
  if (!isCodexProvider(model?.provider)) {
    throw new Error("The active model is not using the openai-codex provider.");
  }

  const auth = await waitForAuth(
    ctx.modelRegistry.getApiKeyAndHeaders(model),
    signal,
  );
  signal?.throwIfAborted();
  if (!auth.ok || !auth.apiKey) {
    throw new Error(
      auth.ok
        ? "No ChatGPT OAuth token is available."
        : auth.error || "Could not resolve ChatGPT authentication.",
    );
  }

  const headers = new Headers();
  headers.set("authorization", `Bearer ${auth.apiKey}`);
  headers.set("accept", "application/json");
  headers.set("user-agent", "pi-codex-statusline");
  const accountId = getAccountId(auth.apiKey);
  if (accountId) headers.set("chatgpt-account-id", accountId);

  const response = await fetchImpl(endpoint, {
    headers,
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    // Release the connection without downloading an unused error body.
    await response.body?.cancel();
    throw new Error(`ChatGPT usage request failed (${response.status}).`);
  }

  const snapshot = parseUsageResponse(await response.json());
  if (!snapshot.fiveHour && !snapshot.weekly) {
    throw new Error("ChatGPT returned no recognized usage windows.");
  }
  return snapshot;
}
