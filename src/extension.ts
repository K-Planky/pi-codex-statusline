import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isCodexProvider } from "./auth.ts";
import { USAGE_POLL_MS, USAGE_TIMEOUT_MS } from "./constants.ts";
import { installFooter } from "./footer.ts";
import type { StatuslineState } from "./types.ts";
import { fetchCodexUsage } from "./usage.ts";

const noop = () => {};

export default function codexStatusline(pi: ExtensionAPI): void {
  const state: StatuslineState = {
    context: undefined,
    usageSnapshot: undefined,
    requestRender: noop,
  };
  let active = false;
  let working = false;
  let usagePollTimer: ReturnType<typeof setTimeout> | undefined;
  let usageProvider: string | undefined;
  let requestController: AbortController | undefined;
  let disposeFooter = noop;

  function cancelUsageRequest() {
    requestController?.abort();
    requestController = undefined;
  }

  function clearUsagePoll() {
    if (usagePollTimer !== undefined) clearTimeout(usagePollTimer);
    usagePollTimer = undefined;
  }

  function scheduleUsagePoll() {
    if (!active || !working || !usageProvider || usagePollTimer !== undefined) {
      return;
    }

    const timer = setTimeout(() => {
      if (usagePollTimer !== timer) return;
      usagePollTimer = undefined;
      // Do not interrupt an in-flight refresh. Timed-out requests may be retried.
      if (!requestController || requestController.signal.aborted) {
        void refreshUsage(state.context);
      }
      scheduleUsagePoll();
    }, USAGE_POLL_MS);
    timer.unref?.();
    usagePollTimer = timer;
  }

  function updateContext(ctx: ExtensionContext): void {
    state.context = ctx;
    const provider = isCodexProvider(ctx.model?.provider)
      ? ctx.model?.provider
      : undefined;

    if (provider !== usageProvider) {
      clearUsagePoll();
      cancelUsageRequest();
      state.usageSnapshot = undefined;
      usageProvider = provider;
      scheduleUsagePoll();
    }
  }

  async function refreshUsage(ctx: ExtensionContext | undefined): Promise<void> {
    if (!active || !usageProvider || !ctx) return;

    cancelUsageRequest();
    const controller = new AbortController();
    requestController = controller;
    const timeout = setTimeout(
      () => controller.abort(new Error("ChatGPT usage request timed out.")),
      USAGE_TIMEOUT_MS,
    );
    timeout.unref?.();

    try {
      const snapshot = await fetchCodexUsage(ctx, {
        signal: controller.signal,
      });
      if (
        active &&
        !controller.signal.aborted &&
        requestController === controller
      ) {
        state.usageSnapshot = snapshot;
        state.requestRender();
      }
    } catch {
      // Keep the last successful snapshot; unavailable usage stays quiet.
    } finally {
      clearTimeout(timeout);
      if (requestController === controller) requestController = undefined;
    }
  }

  function stopSession() {
    active = false;
    working = false;
    clearUsagePoll();
    cancelUsageRequest();
    disposeFooter();
    disposeFooter = noop;
    state.context = undefined;
    state.usageSnapshot = undefined;
    state.requestRender = noop;
    usageProvider = undefined;
  }

  function handleDisplayChange(_event: unknown, ctx: ExtensionContext): void {
    if (!active) return;
    updateContext(ctx);
    state.requestRender();
  }

  pi.registerCommand("usage", {
    description: "Silently refresh Codex usage in the footer",
    handler: async (_args, ctx) => {
      if (!active) return;
      updateContext(ctx);
      await refreshUsage(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    stopSession();
    if (ctx.mode !== "tui") return;

    active = true;
    updateContext(ctx);
    disposeFooter = installFooter(pi, ctx, state);
    void refreshUsage(ctx);
  });

  pi.on("model_select", handleDisplayChange);
  pi.on("thinking_level_select", handleDisplayChange);

  pi.on("agent_start", (_event, ctx) => {
    if (!active) return;
    working = true;
    updateContext(ctx);
    scheduleUsagePoll();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!active) return;
    working = false;
    clearUsagePoll();
    updateContext(ctx);
    state.requestRender();
    void refreshUsage(ctx);
  });

  pi.on("session_shutdown", () => {
    stopSession();
  });
}
