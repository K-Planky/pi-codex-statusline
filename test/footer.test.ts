import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import type { StatuslineState } from "../src/types.ts";
import {
  createContext as hostContext, createModel, contextUsage, emptyFooterData, mockHost,
  plainTheme, required, thinkingAPI, useFakeTimers, type FooterFactory,
} from "./helpers.ts";

import { COUNTDOWN_TICK_MS } from "../src/constants.ts";
import { installFooter, renderStatusLine as render } from "../src/footer.ts";

const NOW = 1_700_000_000_000;

// Tests may omit unrelated host APIs and state; the production signatures stay strict.
function renderStatusLine(
  pi: Partial<ExtensionAPI>,
  ctx: ExtensionContext,
  state: Partial<StatuslineState>,
  footerData: ReadonlyFooterDataProvider,
  theme: Pick<Theme, "fg">,
  width: number,
  nowMs: number,
) {
  return render(mockHost<ExtensionAPI>(pi), ctx, {
    context: undefined, usageSnapshot: undefined, requestRender: () => {}, ...state,
  }, footerData, mockHost<Theme>(theme), width, nowMs);
}

function createContext({
  provider = "openai-codex",
  id = "gpt-5.3-codex-spark",
  reasoning = true,
  thinkingLevel = "high",
  percent = 34.9,
}: {
  provider?: string;
  id?: string;
  reasoning?: boolean;
  thinkingLevel?: NonNullable<ExtensionContext["thinkingLevel"]>;
  percent?: number;
} = {}) {
  const model = createModel({ provider, id, reasoning });
  return {
    ...hostContext({ thinkingLevel, getContextUsage: () => contextUsage(percent) }),
    model,
  };
}

function createFooterData(statuses: [string, string][] = []): ReadonlyFooterDataProvider {
  return {
    ...emptyFooterData,
    getExtensionStatuses: () => new Map(statuses),
  };
}

function createUsageSnapshot() {
  return {
    fiveHour: {
      usedPercent: 28.9,
      windowSeconds: 18_000,
      resetAt: NOW / 1000 + (2 * 60 + 14) * 60,
    },
    weekly: {
      usedPercent: 61.4,
      windowSeconds: 604_800,
      resetAt: NOW / 1000 + (4 * 24 + 9) * 60 * 60,
    },
  };
}

test("aligns countdown redraws and preserves an unchanged timer", (t) => {
  const originalNow = Date.now;
  t.after(() => {
    Date.now = originalNow;
  });

  let nowMs = NOW;
  Date.now = () => nowMs;
  const { timers, clearedTimers } = useFakeTimers(t);

  let footerFactory: FooterFactory | undefined;
  const ctx = createContext();
  ctx.ui = mockHost<ExtensionContext["ui"]>({
    setFooter(factory) {
      footerFactory = factory;
    },
  });
  const state = {
    context: ctx,
    usageSnapshot: {
      fiveHour: {
        usedPercent: 42,
        windowSeconds: 18_000,
        resetAt: NOW / 1000 + 90,
      },
      weekly: undefined,
    },
    requestRender: () => {},
  };
  const disposeFooter = installFooter(
    thinkingAPI,
    ctx,
    state,
  );

  let redraws = 0;
  const component = required(footerFactory)(
    mockHost<Parameters<FooterFactory>[0]>({
      requestRender() {
        redraws++;
      },
    }),
    plainTheme,
    createFooterData(),
  );

  assert.match(required(component.render(200)[0]), /5h 42% \(0h02m\)/);
  assert.equal(required(timers[0]).delay, 30_000);
  assert.equal(required(timers[0]).unrefCalls, 1);

  nowMs += 5_000;
  component.render(200);
  assert.equal(timers.length, 1);
  assert.deepEqual(clearedTimers, []);

  nowMs = NOW + 30_000;
  required(timers[0]).callback();
  assert.equal(redraws, 1);
  assert.match(required(component.render(200)[0]), /5h 42% \(0h01m\)/);
  assert.equal(required(timers[1]).delay, COUNTDOWN_TICK_MS);

  nowMs += COUNTDOWN_TICK_MS;
  required(timers[1]).callback();
  assert.equal(redraws, 2);
  assert.match(required(component.render(200)[0]), /5h 0%$/);
  assert.equal(timers.length, 2);

  state.usageSnapshot.fiveHour.resetAt = nowMs / 1000 + 90;
  ctx.model.provider = "openai";
  component.render(200);
  assert.equal(timers.length, 2);

  ctx.model.provider = "openai-codex";
  component.render(200);
  nowMs += 5_000;
  component.render(200);
  assert.equal(timers.length, 3);

  state.usageSnapshot.fiveHour.resetAt = nowMs / 1000 + 80;
  component.render(200);
  assert.equal(required(timers[3]).delay, 20_000);
  assert.deepEqual(clearedTimers, [timers[2]]);

  disposeFooter();
  assert.deepEqual(clearedTimers, [timers[2], timers[3]]);
  required(component.dispose)();
  assert.deepEqual(clearedTimers, [timers[2], timers[3]]);
  required(timers[2]).callback();
  required(timers[3]).callback();
  state.requestRender();
  assert.equal(redraws, 2);

  // A queued render after disposal must not resurrect background resources.
  component.render(200);
  assert.equal(timers.length, 4);
});

test("renders the complete status line at wide terminal widths", () => {
  const line = renderStatusLine(
    { getThinkingLevel: () => "high" },
    createContext(),
    { usageSnapshot: createUsageSnapshot() },
    createFooterData([
      ["z", "beta   busy"],
      ["a", " alpha\tready\n"],
    ]),
    plainTheme,
    200,
    NOW,
  );

  assert.equal(
    line,
    "GPT-5.3 Spark High · alpha ready beta busy · ctx 34% · " +
      "5h 28% (2h14m) · 7d 61% (4d9h)",
  );
});

test("capitalizes thinking levels from the context fallback", () => {
  for (const [level, label] of [
    ["off", "Off"],
    ["minimal", "Minimal"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
    ["xhigh", "XHigh"],
  ] as const) {
    const line = renderStatusLine(
      {},
      createContext({ thinkingLevel: level }),
      {},
      createFooterData(),
      plainTheme,
      200,
      NOW,
    );
    assert.equal(
      line,
      `GPT-5.3 Spark ${label} · ctx 34%`,
    );
  }
});

test("uses warning and error theme colors only at their thresholds", () => {
  const codes = {
    dim: "\u001b[2m",
    error: "\u001b[31m",
    muted: "\u001b[90m",
    warning: "\u001b[33m",
  };
  const theme: Pick<Theme, "fg"> = {
    fg(color, text) {
      assert.ok(color in codes, `Unexpected theme color: ${color}`);
      return `${codes[color as keyof typeof codes]}${text}\u001b[0m`;
    },
  };
  const snapshot = createUsageSnapshot();
  snapshot.fiveHour.usedPercent = 75;
  snapshot.weekly.usedPercent = 90;

  const line = renderStatusLine(
    { getThinkingLevel: () => "high" },
    createContext({ percent: 60 }),
    { usageSnapshot: snapshot },
    createFooterData(),
    theme,
    200,
    NOW,
  );

  assert.match(line, /\u001b\[90mctx 60%\u001b\[0m/);
  assert.match(line, /\u001b\[33m75%\u001b\[0m/);
  assert.match(line, /\u001b\[31m90%\u001b\[0m/);
  assert.equal(
    stripVTControlCharacters(line),
    "GPT-5.3 Spark High · ctx 60% · " +
      "5h 75% (2h14m) · 7d 90% (4d9h)",
  );
});

test("context colors change at the documented 75% and 85% thresholds", () => {
  const theme: Pick<Theme, "fg"> = { fg: (color, text) => `<${color}>${text}</${color}>` };
  for (const [percent, color] of [
    [74.9, "muted"],
    [75, "warning"],
    [84.9, "warning"],
    [85, "error"],
  ] as const) {
    const line = renderStatusLine(
      {}, createContext({ percent }), {}, createFooterData(), theme, 200, NOW,
    );
    assert.ok(line.includes(`<${color}>ctx ${Math.floor(percent)}%</${color}>`));
  }
});

test("keeps context visible and never exceeds the terminal width", () => {
  const context = createContext({ id: "模型-gpt-5.3-codex-spark-very-long" });
  const state = { usageSnapshot: createUsageSnapshot() };
  const footerData = createFooterData([
    ["status", "\u001b[36mstatus with a very long value\u001b[0m"],
  ]);
  const theme: Pick<Theme, "fg"> = {
    fg: (_color, text) => `\u001b[90m${text}\u001b[0m`,
  };

  assert.equal(
    renderStatusLine({}, context, state, footerData, theme, 0, NOW),
    "",
  );

  for (let width = 1; width <= 120; width++) {
    const line = renderStatusLine(
      {},
      context,
      state,
      footerData,
      theme,
      width,
      NOW,
    );
    assert.ok(
      visibleWidth(line) <= width,
      `line width ${visibleWidth(line)} exceeded ${width}`,
    );
  }

  assert.equal(
    renderStatusLine(
      {},
      createContext(),
      state,
      createFooterData(),
      plainTheme,
      7,
      NOW,
    ),
    "ctx 34%",
  );
});

test("reads context usage once per render, even at narrow widths", () => {
  let reads = 0;
  const ctx = createContext();
  ctx.getContextUsage = () => contextUsage(++reads);

  const render = (width: number) => renderStatusLine(
    {}, ctx, { usageSnapshot: createUsageSnapshot() },
    createFooterData(), plainTheme, width, NOW,
  );

  assert.equal(render(0), "");
  assert.equal(reads, 0);
  assert.equal(render(6), "ctx 1%");
  assert.equal(reads, 1);
  assert.equal(render(6), "ctx 2%");
  assert.equal(reads, 2);
});

test("renders unknown context safely and hides quota for other providers", () => {
  const line = renderStatusLine(
    {},
    createContext({
      provider: "openai",
      reasoning: false,
      percent: Number.POSITIVE_INFINITY,
    }),
    { usageSnapshot: createUsageSnapshot() },
    createFooterData(),
    plainTheme,
    200,
    NOW,
  );

  assert.equal(line, "GPT-5.3 Spark · ctx ?");
});
