import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { isCodexProvider } from "./auth.ts";
import {
  CONTEXT_CRITICAL_PERCENT,
  CONTEXT_WARN_PERCENT,
  COUNTDOWN_TICK_MS,
  MAX_FIVE_HOUR_RESET_SECONDS,
  MAX_MODEL_WIDTH,
  MAX_WEEK_RESET_SECONDS,
  QUOTA_CRITICAL_PERCENT,
  QUOTA_WARN_PERCENT,
} from "./constants.ts";
import {
  effectiveUsedPercent,
  formatModelName,
  formatWindowCountdown,
  sanitizeSingleLine,
} from "./format.ts";
import type { QuotaLabel, StatuslineState, UsageSnapshot, UsageWindow } from "./types.ts";

interface Layout {
  readonly statuses: boolean;
  readonly countdowns: boolean;
  readonly thinking: boolean;
  readonly model: boolean;
  readonly modelWidth?: number;
  readonly fiveHour?: boolean;
  readonly weekly?: boolean;
}

const noop = () => {};

const COUNTDOWN_WINDOWS = [
  ["fiveHour", MAX_FIVE_HOUR_RESET_SECONDS * 1000],
  ["weekly", MAX_WEEK_RESET_SECONDS * 1000],
] as const;

const LAYOUTS: readonly Layout[] = [
  {
    statuses: true,
    countdowns: true,
    thinking: true,
    model: true,
    modelWidth: MAX_MODEL_WIDTH,
  },
  {
    statuses: false,
    countdowns: true,
    thinking: true,
    model: true,
    modelWidth: MAX_MODEL_WIDTH,
  },
  {
    statuses: false,
    countdowns: true,
    thinking: false,
    model: true,
    modelWidth: 14,
  },
  {
    statuses: false,
    countdowns: false,
    thinking: true,
    model: true,
    modelWidth: MAX_MODEL_WIDTH,
  },
  {
    statuses: false,
    countdowns: false,
    thinking: false,
    model: true,
    modelWidth: 12,
  },
  {
    statuses: false,
    countdowns: false,
    thinking: false,
    model: false,
  },
  {
    statuses: false,
    countdowns: false,
    thinking: false,
    model: false,
    weekly: false,
  },
  {
    statuses: false,
    countdowns: false,
    thinking: false,
    model: false,
    fiveHour: false,
    weekly: false,
  },
];

function ambient(theme: Theme, text: string): string {
  return theme.fg("muted", text);
}

function renderModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  layout: Layout,
  theme: Theme,
): string | undefined {
  if (!layout.model || !ctx.model?.id) return undefined;

  let text = formatModelName(ctx.model.id, layout.modelWidth);
  if (layout.thinking && ctx.model.reasoning) {
    const level = pi.getThinkingLevel?.() ?? ctx.thinkingLevel;
    if (level) {
      const label = level === "xhigh"
        ? "XHigh"
        : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
      text += ` ${label}`;
    }
  }
  return ambient(theme, text);
}

function renderContext(ctx: ExtensionContext, theme: Theme): string {
  const context = ctx.getContextUsage();
  if (
    context?.percent === null ||
    (context?.percent !== undefined && !Number.isFinite(context.percent))
  ) {
    return ambient(theme, "ctx ?");
  }

  const percent = Math.floor(
    Math.max(0, Math.min(100, context?.percent ?? 0)),
  );
  const text = `ctx ${percent}%`;
  if (percent >= CONTEXT_CRITICAL_PERCENT) return theme.fg("error", text);
  if (percent >= CONTEXT_WARN_PERCENT) return theme.fg("warning", text);
  return ambient(theme, text);
}

function renderQuota(
  label: QuotaLabel,
  window: UsageWindow | undefined,
  countdowns: boolean,
  theme: Theme,
  nowMs: number,
): string | undefined {
  const percent = effectiveUsedPercent(window, nowMs);
  if (percent === undefined) return undefined;

  const value = `${percent}%`;
  const valueText =
    percent >= QUOTA_CRITICAL_PERCENT
      ? theme.fg("error", value)
      : percent >= QUOTA_WARN_PERCENT
        ? theme.fg("warning", value)
        : ambient(theme, value);
  const countdown = countdowns
    ? formatWindowCountdown(label, window, nowMs)
    : undefined;

  return `${ambient(theme, `${label} `)}${valueText}${
    countdown ? ambient(theme, ` (${countdown})`) : ""
  }`;
}

function getNextCountdownRedrawAt(
  ctx: ExtensionContext,
  snapshot: UsageSnapshot | undefined,
  nowMs: number,
): number | undefined {
  if (!isCodexProvider(ctx.model?.provider) || !snapshot) return undefined;

  let nextRedrawAt = Number.POSITIVE_INFINITY;

  for (const [windowName, maxDelay] of COUNTDOWN_WINDOWS) {
    const resetAt = snapshot[windowName]?.resetAt;
    if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) continue;

    const resetDelay = resetAt * 1000 - nowMs;
    if (resetDelay <= 0 || resetDelay > maxDelay) continue;

    // Countdown minutes are rounded up, so boundaries align to reset time.
    const remainder = resetDelay % COUNTDOWN_TICK_MS;
    const boundaryDelay = remainder === 0 ? COUNTDOWN_TICK_MS : remainder;
    const redrawAt = nowMs + Math.max(1, Math.ceil(boundaryDelay));
    nextRedrawAt = Math.min(nextRedrawAt, redrawAt);
  }

  return Number.isFinite(nextRedrawAt) ? nextRedrawAt : undefined;
}

function renderStatuses(footerData: ReadonlyFooterDataProvider): string {
  return Array.from(footerData.getExtensionStatuses().entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => sanitizeSingleLine(text))
    .filter(Boolean)
    .join(" ");
}

function buildLine(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: StatuslineState,
  footerData: ReadonlyFooterDataProvider,
  theme: Theme,
  layout: Layout,
  nowMs: number,
  contextText: string,
): string {
  const segments = [];
  const model = renderModel(pi, ctx, layout, theme);
  if (model) segments.push(model);

  if (layout.statuses) {
    const statuses = renderStatuses(footerData);
    if (statuses) segments.push(statuses);
  }

  segments.push(contextText);

  if (isCodexProvider(ctx.model?.provider) && state.usageSnapshot) {
    if (layout.fiveHour !== false) {
      const fiveHour = renderQuota(
        "5h",
        state.usageSnapshot.fiveHour,
        layout.countdowns,
        theme,
        nowMs,
      );
      if (fiveHour) segments.push(fiveHour);
    }
    if (layout.weekly !== false) {
      const weekly = renderQuota(
        "7d",
        state.usageSnapshot.weekly,
        layout.countdowns,
        theme,
        nowMs,
      );
      if (weekly) segments.push(weekly);
    }
  }

  return segments.join(theme.fg("dim", " · "));
}

export function renderStatusLine(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: StatuslineState,
  footerData: ReadonlyFooterDataProvider,
  theme: Theme,
  width: number,
  nowMs = Date.now(),
): string {
  if (width <= 0) return "";

  const contextText = renderContext(ctx, theme);
  let shortest = contextText;
  for (const layout of LAYOUTS) {
    const line = buildLine(
      pi,
      ctx,
      state,
      footerData,
      theme,
      layout,
      nowMs,
      contextText,
    );
    shortest = line;
    if (visibleWidth(line) <= width) return line;
  }

  return truncateToWidth(shortest, width, "");
}

export function installFooter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: StatuslineState,
): () => void {
  let disposeCurrent = noop;

  ctx.ui.setFooter((tui, theme, footerData) => {
    disposeCurrent();

    let disposed = false;
    const requestRender = () => {
      if (!disposed) tui.requestRender();
    };
    let countdownTimer: ReturnType<typeof setTimeout> | undefined;
    let countdownRedrawAt: number | undefined;
    state.requestRender = requestRender;

    function clearCountdownTimer() {
      if (countdownTimer !== undefined) clearTimeout(countdownTimer);
      countdownTimer = undefined;
      countdownRedrawAt = undefined;
    }

    function scheduleCountdownRedraw(context: ExtensionContext, nowMs: number): void {
      const redrawAt = getNextCountdownRedrawAt(
        context,
        state.usageSnapshot,
        nowMs,
      );
      if (countdownTimer !== undefined && redrawAt === countdownRedrawAt) {
        return;
      }

      clearCountdownTimer();
      if (redrawAt === undefined) return;

      const delay = Math.max(1, redrawAt - Date.now());

      // This advances the local display only; usage polling has its own lifecycle.
      const timer = setTimeout(() => {
        if (countdownTimer !== timer) return;
        countdownTimer = undefined;
        countdownRedrawAt = undefined;
        requestRender();
      }, delay);
      timer.unref?.();
      countdownTimer = timer;
      countdownRedrawAt = redrawAt;
    }

    function dispose() {
      disposed = true;
      clearCountdownTimer();
      if (state.requestRender === requestRender) state.requestRender = noop;
      if (disposeCurrent === dispose) disposeCurrent = noop;
    }

    disposeCurrent = dispose;
    return {
      dispose,
      invalidate() {},
      render(width) {
        if (disposed) return [""];
        const context = state.context ?? ctx;
        const nowMs = Date.now();
        const line = renderStatusLine(
          pi,
          context,
          state,
          footerData,
          theme,
          width,
          nowMs,
        );
        scheduleCountdownRedraw(context, nowMs);
        return [line];
      },
    };
  });

  return () => disposeCurrent();
}
