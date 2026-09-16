import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A validated window from ChatGPT's usage API. Reset times are Unix seconds. */
export interface UsageWindow {
  readonly usedPercent: number;
  readonly windowSeconds: number;
  readonly resetAt: number | undefined;
}

export interface UsageSnapshot {
  readonly fiveHour: UsageWindow | undefined;
  readonly weekly: UsageWindow | undefined;
}

export type QuotaLabel = "5h" | "7d";

/** Session-owned state shared by event handlers and the footer component. */
export interface StatuslineState {
  context: ExtensionContext | undefined;
  usageSnapshot: UsageSnapshot | undefined;
  requestRender: () => void;
}
