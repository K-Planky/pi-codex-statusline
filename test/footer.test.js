import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { COUNTDOWN_TICK_MS } from "../src/constants.js";
import { installFooter, renderStatusLine } from "../src/footer.js";

const NOW = 1_700_000_000_000;
const plainTheme = { fg: (_color, text) => text };

function createContext({
  provider = "openai-codex",
  id = "gpt-5.3-codex-spark",
  reasoning = true,
  thinkingLevel = "high",
  percent = 34.9,
} = {}) {
  return {
    model: { provider, id, reasoning },
    thinkingLevel,
    getContextUsage: () => ({ percent }),
  };
}

function createFooterData(statuses = []) {
  return {
    getExtensionStatuses: () => new Map(statuses),
  };
}

function createUsageSnapshot() {
  return {
    fiveHour: {
      usedPercent: 28.9,
      resetAt: NOW / 1000 + (2 * 60 + 14) * 60,
    },
    weekly: {
      usedPercent: 61.4,
      resetAt: NOW / 1000 + (4 * 24 + 9) * 60 * 60,
    },
  };
}

test("aligns countdown redraws and preserves an unchanged timer", (t) => {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  t.after(() => {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  let nowMs = NOW;
  Date.now = () => nowMs;
  const timers = [];
  const clearedTimers = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = {
      callback,
      delay,
      unrefCalls: 0,
      unref() {
        this.unrefCalls++;
      },
    };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => clearedTimers.push(timer);

  let footerFactory;
  const ctx = createContext();
  ctx.ui = {
    setFooter(factory) {
      footerFactory = factory;
    },
  };
  const state = {
    context: ctx,
    usageSnapshot: {
      fiveHour: {
        usedPercent: 42,
        resetAt: NOW / 1000 + 90,
      },
    },
    requestRender: () => {},
  };
  const disposeFooter = installFooter(
    { getThinkingLevel: () => "high" },
    ctx,
    state,
  );

  let redraws = 0;
  const component = footerFactory(
    {
      requestRender() {
        redraws++;
      },
    },
    plainTheme,
    createFooterData(),
  );

  assert.match(component.render(200)[0], /5h 42% \(0h02m\)/);
  assert.equal(timers[0].delay, 30_000);
  assert.equal(timers[0].unrefCalls, 1);

  nowMs += 5_000;
  component.render(200);
  assert.equal(timers.length, 1);
  assert.deepEqual(clearedTimers, []);

  nowMs = NOW + 30_000;
  timers[0].callback();
  assert.equal(redraws, 1);
  assert.match(component.render(200)[0], /5h 42% \(0h01m\)/);
  assert.equal(timers[1].delay, COUNTDOWN_TICK_MS);

  nowMs += COUNTDOWN_TICK_MS;
  timers[1].callback();
  assert.equal(redraws, 2);
  assert.match(component.render(200)[0], /5h 0%$/);
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
  assert.equal(timers[3].delay, 20_000);
  assert.deepEqual(clearedTimers, [timers[2]]);

  disposeFooter();
  assert.deepEqual(clearedTimers, [timers[2], timers[3]]);
  component.dispose();
  assert.deepEqual(clearedTimers, [timers[2], timers[3]]);
  timers[2].callback();
  timers[3].callback();
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
  ]) {
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
  const theme = {
    fg(color, text) {
      return `${codes[color]}${text}\u001b[0m`;
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

  assert.match(line, /\u001b\[33mctx 60%\u001b\[0m/);
  assert.match(line, /\u001b\[33m75%\u001b\[0m/);
  assert.match(line, /\u001b\[31m90%\u001b\[0m/);
  assert.equal(
    stripVTControlCharacters(line),
    "GPT-5.3 Spark High · ctx 60% · " +
      "5h 75% (2h14m) · 7d 90% (4d9h)",
  );
});

test("keeps context visible and never exceeds the terminal width", () => {
  const context = createContext({ id: "模型-gpt-5.3-codex-spark-very-long" });
  const state = { usageSnapshot: createUsageSnapshot() };
  const footerData = createFooterData([
    ["status", "\u001b[36mstatus with a very long value\u001b[0m"],
  ]);
  const theme = {
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
  ctx.getContextUsage = () => ({ percent: ++reads });

  const render = (width) => renderStatusLine(
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
