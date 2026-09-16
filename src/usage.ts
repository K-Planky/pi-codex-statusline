import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getAccountId, isCodexProvider } from "./auth.ts";
import type { UsageSnapshot, UsageWindow } from "./types.ts";
import {
  FIVE_HOUR_SECONDS,
  USAGE_URL,
  WEEK_SECONDS,
} from "./constants.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function normalizeUsageWindow(value: unknown): UsageWindow | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const usedPercent = finiteNumber(record.used_percent);
  const windowSeconds = finiteNumber(record.limit_window_seconds);
  const resetAt = finiteNumber(record.reset_at);
  if (usedPercent === undefined || windowSeconds === undefined) return undefined;

  return { usedPercent, windowSeconds, resetAt };
}

export function parseUsageResponse(data: unknown): UsageSnapshot {
  const payload = asRecord(data);
  const rateLimit = asRecord(payload?.rate_limit);
  const windows = [
    normalizeUsageWindow(rateLimit?.primary_window),
    normalizeUsageWindow(rateLimit?.secondary_window),
  ].filter((window) => window !== undefined);

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
async function waitForAuth<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;

  let onAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
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

export interface FetchUsageOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof globalThis.fetch;
  endpoint?: string;
}

export async function fetchCodexUsage(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  {
    signal,
    fetchImpl = globalThis.fetch,
    endpoint = USAGE_URL,
  }: FetchUsageOptions = {},
): Promise<UsageSnapshot> {
  signal?.throwIfAborted();
  const model = ctx.model;
  if (!model || !isCodexProvider(model.provider)) {
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
    signal: signal ?? null,
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
