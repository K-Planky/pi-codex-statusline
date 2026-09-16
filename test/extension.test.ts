import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import {
  createContext, createModel, createFooter, deferred, mockHost, required, useFakeTimers,
  type AuthResult, type FooterFactory,
} from "./helpers.ts";

import { USAGE_POLL_MS, USAGE_TIMEOUT_MS } from "../src/constants.ts";
import codexStatusline from "../index.ts";

function flushAsyncWork() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function usageResponse(usedPercent: number, resetAt?: number): Response {
  return Response.json({
    rate_limit: {
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: resetAt,
      },
    },
  });
}

type TestHandler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;
type TestEvent = "session_start" | "session_shutdown" | "agent_start" | "agent_end"
  | "agent_settled" | "model_select" | "thinking_level_select";

function createHarness() {
  const handlers = new Map<string, TestHandler>();
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const pi = mockHost<ExtensionAPI>({
    registerCommand(name, command) {
      commands.set(name, command);
    },
    getThinkingLevel: () => "high",
    on(event, handler) {
      // The heterogeneous registry erases the overload's event/handler pairing.
      // emit() below always dispatches a matching, type-checked event fixture.
      handlers.set(event, handler as TestHandler);
    },
  });

  let footerFactory: FooterFactory | undefined;
  const ctx = createContext({
    ui: mockHost<ExtensionContext["ui"]>({
      setFooter(factory) { footerFactory = factory; },
    }),
  });

  function emit(type: TestEvent) {
    const events = {
      session_start: { type: "session_start", reason: "startup" },
      session_shutdown: { type: "session_shutdown", reason: "quit" },
      agent_start: { type: "agent_start" },
      agent_end: { type: "agent_end", messages: [] },
      agent_settled: { type: "agent_settled" },
      model_select: { type: "model_select", model: required(ctx.model), previousModel: undefined, source: "set" },
      thinking_level_select: { type: "thinking_level_select", level: "high", previousLevel: "low" },
    } satisfies { [K in TestEvent]: Extract<ExtensionEvent, { type: K }> };
    // agent_end is intentionally unhandled: low-level run boundaries must not stop polling.
    const handler = handlers.get(type);
    if (type !== "agent_end") assert.ok(handler, `Missing handler for ${type}`);
    return handler?.(events[type], ctx);
  }

  codexStatusline(pi);
  return {
    ctx,
    emit,
    command: () => required(commands.get("usage")),
    start: () => emit("session_start"),
    createFooter(requestRender = () => {}) {
      return createFooter(required(footerFactory), requestRender);
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
  assert.match(required(component.render(200)[0]), /5h 10%/);

  harness.emit("thinking_level_select");
  harness.ctx.model = createModel({ provider: "openai", id: "gpt-5.4" });
  harness.emit("model_select");
  harness.ctx.model = createModel({
    provider: "openai-codex",
    id: "gpt-5.4",
    reasoning: true,
  });
  harness.emit("model_select");
  await flushAsyncWork();
  assert.equal(requests, 1);

  harness.emit("agent_settled");
  await flushAsyncWork();
  assert.equal(requests, 2);
  assert.match(required(component.render(200)[0]), /5h 20%/);

  harness.emit("session_shutdown");
  required(component.dispose)();
});

function createPollingHarness(t: TestContext, fetchImpl: typeof globalThis.fetch) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = createHarness();
  t.after(() => {
    harness.emit("session_shutdown");
    globalThis.fetch = originalFetch;
  });
  return {
    ...harness,
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
  const command = harness.command();
  // No messaging, persistence, or notification APIs are provided by the harness.
  assert.equal(await command.handler("", harness.ctx), undefined);
  assert.equal(requests, 2);
  assert.match(required(component.render(200)[0]), /5h 20%/);
  assert.equal(await command.handler("", harness.ctx), undefined);
  assert.match(required(component.render(200)[0]), /5h 20%/);
  await harness.tick(USAGE_POLL_MS * 3);
  assert.equal(requests, 3);
});

test("usage quietly skips non-Codex models and inactive sessions", async (t) => {
  let requests = 0;
  const harness = createPollingHarness(t, async () => usageResponse(++requests));
  const command = harness.command();
  await command.handler("", harness.ctx);
  harness.ctx.model = createModel({ provider: "openai", id: "gpt-5.4" });
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
  assert.match(required(component.render(200)[0]), /5h 20%/);

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

  harness.ctx.model = createModel({ provider: "openai", id: "gpt-5.4" });
  harness.emit("model_select");
  await harness.tick(USAGE_POLL_MS * 3);
  assert.equal(requests, 1);

  harness.ctx.model = createModel({ provider: "openai-codex", id: "gpt-5.4" });
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
  assert.match(required(component.render(200)[0]), /5h 10%/);
  await harness.tick();
  assert.equal(requests, 3);
  assert.match(required(component.render(200)[0]), /5h 30%/);
});

test("shutdown cancels polling and ignores its in-flight response", async (t) => {
  let requests = 0;
  const fetchResult = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const harness = createPollingHarness(t, async (_url, options) => {
    if (++requests === 1) return usageResponse(10);
    signal = options?.signal;
    return fetchResult.promise;
  });
  harness.start();
  await flushAsyncWork();
  let redraws = 0;
  harness.createFooter(() => redraws++);
  harness.emit("agent_start");
  await harness.tick();
  assert.equal(requests, 2);
  harness.emit("session_shutdown");
  assert.equal(required(signal).aborted, true);
  fetchResult.resolve(usageResponse(90));
  await harness.tick(USAGE_POLL_MS * 3);
  assert.equal(requests, 2);
  assert.equal(redraws, 0);
});

test("retries a timed-out poll and discards its late response", async (t) => {
  let requests = 0;
  const fetchResult = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const harness = createPollingHarness(t, async (_url, options) => {
    if (++requests !== 2) return usageResponse(requests * 10);
    signal = options?.signal;
    return fetchResult.promise;
  });
  harness.start();
  await flushAsyncWork();
  const component = harness.createFooter();
  harness.emit("agent_start");
  await harness.tick();
  await harness.tick(USAGE_TIMEOUT_MS);
  assert.equal(required(signal).aborted, true);
  await harness.tick(USAGE_POLL_MS - USAGE_TIMEOUT_MS);
  assert.equal(requests, 3);
  assert.match(required(component.render(200)[0]), /5h 30%/);

  fetchResult.resolve(usageResponse(90));
  await flushAsyncWork();
  assert.match(required(component.render(200)[0]), /5h 30%/);
});

test("usage command times out while credentials are unresolved", async (t) => {
  let requests = 0;
  const harness = createPollingHarness(t, async () => usageResponse(++requests * 10));
  harness.start();
  await flushAsyncWork();
  const component = harness.createFooter();

  const auth = deferred<AuthResult>();
  harness.ctx.modelRegistry.getApiKeyAndHeaders = () => auth.promise;
  let completed = false;
  const command = harness.command().handler("", harness.ctx)
    .then(() => { completed = true; });
  await harness.tick(USAGE_TIMEOUT_MS);
  assert.equal(completed, true);
  assert.match(required(component.render(200)[0]), /5h 10%/);

  auth.resolve({ ok: true, apiKey: "opaque-token" });
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
  for (const mode of ["rpc", "json", "print"] as const) {
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

  const fetchResult = deferred<Response>();
  let requestSignal: AbortSignal | null | undefined;
  globalThis.fetch = (_url, options) => {
    requestSignal = options?.signal;
    return fetchResult.promise;
  };

  const harness = createHarness();
  harness.start();
  await flushAsyncWork();
  const component = harness.createFooter();

  harness.ctx.model = createModel({ provider: "openai", id: "gpt-5.4" });
  harness.emit("model_select");
  assert.equal(required(requestSignal).aborted, true);

  harness.ctx.model = createModel({
    provider: "openai-codex",
    id: "gpt-5.4",
    reasoning: true,
  });
  harness.emit("model_select");

  fetchResult.resolve(usageResponse(42));
  await flushAsyncWork();
  assert.doesNotMatch(required(component.render(200)[0]), /5h 42%/);

  harness.emit("session_shutdown");
  required(component.dispose)();
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
  assert.equal(required(timers[1]).delay, 30_000);

  harness.emit("session_shutdown");
  assert.deepEqual(clearedTimers, [timers[0], timers[1]]);
  required(timers[1]).callback();
  assert.equal(redraws, 0);

  required(component.dispose)();
  assert.deepEqual(clearedTimers, [timers[0], timers[1]]);
});

test("ignores a usage response that arrives after its timeout", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const fetchResult = deferred<Response>();
  let requestSignal: AbortSignal | null | undefined;
  globalThis.fetch = (_url, options) => {
    requestSignal = options?.signal;
    return fetchResult.promise;
  };

  const { timers, clearedTimers } = useFakeTimers(t);
  const harness = createHarness();
  harness.start();
  await flushAsyncWork();
  const component = harness.createFooter();

  assert.equal(timers.length, 1);
  assert.equal(required(timers[0]).delay, USAGE_TIMEOUT_MS);
  required(timers[0]).callback();
  assert.equal(required(requestSignal).aborted, true);

  fetchResult.resolve(usageResponse(42));
  await flushAsyncWork();
  assert.deepEqual(clearedTimers, [timers[0]]);
  assert.doesNotMatch(required(component.render(200)[0]), /5h 42%/);

  harness.emit("session_shutdown");
  required(component.dispose)();
});
