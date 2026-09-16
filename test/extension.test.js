import assert from "node:assert/strict";
import test from "node:test";

import { USAGE_POLL_MS, USAGE_TIMEOUT_MS } from "../src/constants.js";
import codexStatusline from "../src/extension.js";

const plainTheme = { fg: (_color, text) => text };
const emptyFooterData = { getExtensionStatuses: () => new Map() };

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

function usageResponse(usedPercent, resetAt) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        rate_limit: {
          primary_window: {
            used_percent: usedPercent,
            limit_window_seconds: 5 * 60 * 60,
            reset_at: resetAt,
          },
        },
      };
    },
  };
}

function useFakeTimers(t) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  const timers = [];
  const clearedTimers = [];
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => clearedTimers.push(timer);
  return { timers, clearedTimers };
}

function createHarness() {
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    registerCommand(name, command) {
      commands.set(name, command);
    },
    getThinkingLevel: () => "high",
    on(event, handler) {
      handlers.set(event, handler);
    },
  };

  let footerFactory;
  const ctx = {
    mode: "tui",
    model: {
      provider: "openai-codex",
      id: "gpt-5.4",
      reasoning: true,
    },
    thinkingLevel: "high",
    getContextUsage: () => ({ percent: 20 }),
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "opaque-token" };
      },
    },
    ui: {
      setFooter(factory) {
        footerFactory = factory;
      },
    },
  };

  codexStatusline(pi);
  return {
    ctx,
    handlers,
    commands,
    start() {
      handlers.get("session_start")({}, ctx);
    },
    createFooter(requestRender = () => {}) {
      assert.equal(typeof footerFactory, "function");
      return footerFactory({ requestRender }, plainTheme, emptyFooterData);
    },
  };
}

test("refreshes usage at session start and settlement, not idle display changes", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let requests = 0;
  globalThis.fetch = async () => usageResponse(++requests * 10);

  const harness = createHarness();
  harness.start();
  await flushAsyncWork();
  assert.equal(requests, 1);

  const component = harness.createFooter();
  assert.match(component.render(200)[0], /5h 10%/);

  harness.handlers.get("thinking_level_select")({}, harness.ctx);
  harness.ctx.model = { provider: "openai", id: "gpt-5.4" };
  harness.handlers.get("model_select")({}, harness.ctx);
  harness.ctx.model = {
    provider: "openai-codex",
    id: "gpt-5.4",
    reasoning: true,
  };
  harness.handlers.get("model_select")({}, harness.ctx);
  await flushAsyncWork();
  assert.equal(requests, 1);

  harness.handlers.get("agent_settled")({}, harness.ctx);
  await flushAsyncWork();
  assert.equal(requests, 2);
  assert.match(component.render(200)[0], /5h 20%/);

  harness.handlers.get("session_shutdown")();
  component.dispose();
});

function createPollingHarness(t, fetchImpl) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = createHarness();
  t.after(() => {
    harness.handlers.get("session_shutdown")();
    globalThis.fetch = originalFetch;
  });
  return {
    ...harness,
    emit(event) {
      harness.handlers.get(event)?.({}, harness.ctx);
    },
    async tick(ms = USAGE_POLL_MS) {
      t.mock.timers.tick(ms);
      await flushAsyncWork();
    },
  };
}

test("usage silently refreshes while idle and preserves usage on failure", async (t) => {
  let requests = 0;
  const harness = createPollingHarness(t, async () => {
    if (++requests === 3) throw new Error("offline");
    return usageResponse(requests * 10);
  });
  harness.start();
  await flushAsyncWork();
  const component = harness.createFooter();
  const command = harness.commands.get("usage");
  // No messaging, persistence, or notification APIs are provided by the harness.
  assert.equal(await command.handler("", harness.ctx), undefined);
  assert.equal(requests, 2);
  assert.match(component.render(200)[0], /5h 20%/);
  assert.equal(await command.handler("", harness.ctx), undefined);
  assert.match(component.render(200)[0], /5h 20%/);
  await harness.tick(USAGE_POLL_MS * 3);
  assert.equal(requests, 3);
});

test("usage quietly skips non-Codex models and inactive sessions", async (t) => {
  let requests = 0;
  const harness = createPollingHarness(t, async () => usageResponse(++requests));
  const command = harness.commands.get("usage");
  await command.handler("", harness.ctx);
  harness.ctx.model = { provider: "openai", id: "gpt-5.4" };
  harness.start();
  await command.handler("", harness.ctx);
  harness.emit("session_shutdown");
  await command.handler("", harness.ctx);
  assert.equal(requests, 0);
});

test("polls every minute only while working, including retries and follow-ups", async (t) => {
  let requests = 0;
  const harness = createPollingHarness(t, async () => usageResponse(++requests * 10));
  harness.start();
  await flushAsyncWork();
  await harness.tick(USAGE_POLL_MS * 3);
  assert.equal(requests, 1);

  const component = harness.createFooter();
  harness.emit("agent_start");
  await harness.tick(USAGE_POLL_MS - 1);
  assert.equal(requests, 1);
  await harness.tick(1);
  assert.equal(requests, 2);
  assert.match(component.render(200)[0], /5h 20%/);

  // Low-level run boundaries must not stop or postpone the next poll.
  await harness.tick(USAGE_POLL_MS / 2);
  harness.emit("agent_end");
  harness.emit("agent_start");
  harness.emit("thinking_level_select");
  await harness.tick(USAGE_POLL_MS / 2);
  assert.equal(requests, 3);

  harness.emit("agent_settled");
  await flushAsyncWork();
  assert.equal(requests, 4);
  await harness.tick(USAGE_POLL_MS * 3);
  assert.equal(requests, 4);

  harness.emit("agent_start");
  await harness.tick();
  assert.equal(requests, 5);
});

test("pauses polling away from Codex and resumes during the same task", async (t) => {
  let requests = 0;
  const harness = createPollingHarness(t, async () => usageResponse(++requests));
  harness.start();
  await flushAsyncWork();
  harness.emit("agent_start");
  await harness.tick(USAGE_POLL_MS / 2);

  harness.ctx.model = { provider: "openai", id: "gpt-5.4" };
  harness.emit("model_select");
  await harness.tick(USAGE_POLL_MS * 3);
  assert.equal(requests, 1);

  harness.ctx.model = { provider: "openai-codex", id: "gpt-5.4" };
  harness.emit("model_select");
  await harness.tick();
  assert.equal(requests, 2);
});

test("polling recovers quietly from failures without losing the last snapshot", async (t) => {
  let requests = 0;
  const harness = createPollingHarness(t, async () => {
    if (++requests === 2) throw new Error("offline");
    return usageResponse(requests * 10);
  });
  harness.start();
  await flushAsyncWork();
  const component = harness.createFooter();
  harness.emit("agent_start");
  await harness.tick();
  assert.match(component.render(200)[0], /5h 10%/);
  await harness.tick();
  assert.equal(requests, 3);
  assert.match(component.render(200)[0], /5h 30%/);
});

test("shutdown cancels polling and ignores its in-flight response", async (t) => {
  let requests = 0;
  let resolveFetch;
  let signal;
  const harness = createPollingHarness(t, async (_url, options) => {
    if (++requests === 1) return usageResponse(10);
    signal = options.signal;
    return new Promise((resolve) => { resolveFetch = resolve; });
  });
  harness.start();
  await flushAsyncWork();
  let redraws = 0;
  harness.createFooter(() => redraws++);
  harness.emit("agent_start");
  await harness.tick();
  assert.equal(requests, 2);
  harness.emit("session_shutdown");
  assert.equal(signal.aborted, true);
  resolveFetch(usageResponse(90));
  await harness.tick(USAGE_POLL_MS * 3);
  assert.equal(requests, 2);
  assert.equal(redraws, 0);
});

test("retries a timed-out poll and discards its late response", async (t) => {
  let requests = 0;
  let resolveFetch;
  let signal;
  const harness = createPollingHarness(t, async (_url, options) => {
    if (++requests !== 2) return usageResponse(requests * 10);
    signal = options.signal;
    return new Promise((resolve) => { resolveFetch = resolve; });
  });
  harness.start();
  await flushAsyncWork();
  const component = harness.createFooter();
  harness.emit("agent_start");
  await harness.tick();
  await harness.tick(USAGE_TIMEOUT_MS);
  assert.equal(signal.aborted, true);
  await harness.tick(USAGE_POLL_MS - USAGE_TIMEOUT_MS);
  assert.equal(requests, 3);
  assert.match(component.render(200)[0], /5h 30%/);

  resolveFetch(usageResponse(90));
  await flushAsyncWork();
  assert.match(component.render(200)[0], /5h 30%/);
});

test("usage command times out while credentials are unresolved", async (t) => {
  let requests = 0;
  const harness = createPollingHarness(t, async () => usageResponse(++requests * 10));
  harness.start();
  await flushAsyncWork();
  const component = harness.createFooter();

  let resolveAuth;
  harness.ctx.modelRegistry.getApiKeyAndHeaders = () => new Promise((resolve) => {
    resolveAuth = resolve;
  });
  let completed = false;
  const command = harness.commands.get("usage").handler("", harness.ctx)
    .then(() => { completed = true; });
  await harness.tick(USAGE_TIMEOUT_MS);
  assert.equal(completed, true);
  assert.match(component.render(200)[0], /5h 10%/);

  resolveAuth({ ok: true, apiKey: "opaque-token" });
  await command;
  await flushAsyncWork();
  assert.equal(requests, 1);
});

test("session restart clears the old poll and starts idle", async (t) => {
  let requests = 0;
  const harness = createPollingHarness(t, async () => usageResponse(++requests));
  harness.start();
  await flushAsyncWork();
  harness.emit("agent_start");
  await harness.tick(USAGE_POLL_MS / 2);
  harness.start();
  await flushAsyncWork();
  assert.equal(requests, 2);
  await harness.tick(USAGE_POLL_MS * 2);
  assert.equal(requests, 2);
  harness.emit("agent_start");
  await harness.tick();
  assert.equal(requests, 3);
});

test("does not fetch or poll outside TUI mode", async (t) => {
  let requests = 0;
  const harness = createPollingHarness(t, async () => usageResponse(++requests));
  for (const mode of ["rpc", "json", "print"]) {
    harness.ctx.mode = mode;
    harness.start();
    harness.emit("agent_start");
    await harness.tick();
    harness.emit("agent_settled");
    await flushAsyncWork();
  }
  assert.equal(requests, 0);
});

test("ignores an obsolete usage response after a provider switch", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let resolveFetch;
  let requestSignal;
  globalThis.fetch = (_url, options) => {
    requestSignal = options.signal;
    return new Promise((resolve) => {
      resolveFetch = resolve;
    });
  };

  const harness = createHarness();
  harness.start();
  await flushAsyncWork();
  const component = harness.createFooter();

  harness.ctx.model = { provider: "openai", id: "gpt-5.4" };
  harness.handlers.get("model_select")({}, harness.ctx);
  assert.equal(requestSignal.aborted, true);

  harness.ctx.model = {
    provider: "openai-codex",
    id: "gpt-5.4",
    reasoning: true,
  };
  harness.handlers.get("model_select")({}, harness.ctx);

  resolveFetch(usageResponse(42));
  await flushAsyncWork();
  assert.doesNotMatch(component.render(200)[0], /5h 42%/);

  harness.handlers.get("session_shutdown")();
  component.dispose();
});

test("session shutdown disposes an active countdown timer", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  t.after(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  });

  const nowMs = 1_700_000_000_000;
  Date.now = () => nowMs;
  globalThis.fetch = async () => usageResponse(42, nowMs / 1000 + 90);

  const { timers, clearedTimers } = useFakeTimers(t);
  const harness = createHarness();
  harness.start();
  await flushAsyncWork();
  assert.deepEqual(clearedTimers, [timers[0]]);

  let redraws = 0;
  const component = harness.createFooter(() => redraws++);
  component.render(200);
  assert.equal(timers[1].delay, 30_000);

  harness.handlers.get("session_shutdown")();
  assert.deepEqual(clearedTimers, [timers[0], timers[1]]);
  timers[1].callback();
  assert.equal(redraws, 0);

  component.dispose();
  assert.deepEqual(clearedTimers, [timers[0], timers[1]]);
});

test("ignores a usage response that arrives after its timeout", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let resolveFetch;
  let requestSignal;
  globalThis.fetch = (_url, options) => {
    requestSignal = options.signal;
    return new Promise((resolve) => {
      resolveFetch = resolve;
    });
  };

  const { timers, clearedTimers } = useFakeTimers(t);
  const harness = createHarness();
  harness.start();
  await flushAsyncWork();
  const component = harness.createFooter();

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, USAGE_TIMEOUT_MS);
  timers[0].callback();
  assert.equal(requestSignal.aborted, true);

  resolveFetch(usageResponse(42));
  await flushAsyncWork();
  assert.deepEqual(clearedTimers, [timers[0]]);
  assert.doesNotMatch(component.render(200)[0], /5h 42%/);

  harness.handlers.get("session_shutdown")();
  component.dispose();
});
