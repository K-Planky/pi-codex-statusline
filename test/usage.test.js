import assert from "node:assert/strict";
import test from "node:test";

import { fetchCodexUsage, parseUsageResponse } from "../src/usage.js";

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeToken(payload) {
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

function usagePayload() {
  return {
    plan_type: "pro",
    rate_limit: {
      primary_window: {
        used_percent: 25.9,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: 1_700_001_800,
      },
      secondary_window: {
        used_percent: 42.2,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: 1_700_086_400,
      },
    },
  };
}

test("parses 5-hour and weekly windows by duration", () => {
  const payload = usagePayload();
  const first = payload.rate_limit.primary_window;
  payload.rate_limit.primary_window = payload.rate_limit.secondary_window;
  payload.rate_limit.secondary_window = first;

  const snapshot = parseUsageResponse(payload);

  assert.equal(snapshot.fiveHour.usedPercent, 25.9);
  assert.equal(snapshot.weekly.usedPercent, 42.2);
});

test("ignores malformed and unrecognized usage windows", () => {
  for (const data of [null, [], "bad", {}, { rate_limit: [] }]) {
    assert.deepEqual(parseUsageResponse(data), { fiveHour: undefined, weekly: undefined });
  }
  for (const window of [
    null, [], { used_percent: "25", limit_window_seconds: 18000 },
    { used_percent: NaN, limit_window_seconds: 18000 },
    { used_percent: 25, limit_window_seconds: Infinity },
    { used_percent: 25, limit_window_seconds: 3600 },
  ]) {
    assert.deepEqual(parseUsageResponse({ rate_limit: { primary_window: window } }),
      { fiveHour: undefined, weekly: undefined });
  }
  const payload = usagePayload();
  payload.rate_limit.primary_window.reset_at = "bad";
  assert.equal(parseUsageResponse(payload).fiveHour.resetAt, undefined);
});

test("fetches usage with Pi's OAuth token and account header", async () => {
  const token = fakeToken({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_test",
    },
  });
  const ctx = {
    model: { provider: "openai-codex", id: "gpt-5.4" },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: token, headers: { "x-test": "yes" } };
      },
    },
  };

  const snapshot = await fetchCodexUsage(ctx, {
    endpoint: "https://example.test/usage",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://example.test/usage");
      assert.equal(options.headers.get("authorization"), `Bearer ${token}`);
      assert.equal(options.headers.get("chatgpt-account-id"), "acct_test");
      assert.equal(options.headers.get("x-test"), null);
      assert.equal(options.redirect, "error");
      return {
        ok: true,
        status: 200,
        async json() {
          return usagePayload();
        },
      };
    },
  });

  assert.equal(snapshot.fiveHour.usedPercent, 25.9);
  assert.equal(snapshot.weekly.usedPercent, 42.2);
});

test("rejects unsupported providers and unavailable credentials without fetching", async () => {
  const options = { fetchImpl: () => assert.fail("unexpected fetch") };
  await assert.rejects(fetchCodexUsage({ model: { provider: "openai" } }, options),
    /not using the openai-codex provider/);
  for (const [auth, message] of [
    [{ ok: false, error: "auth unavailable" }, /auth unavailable/],
    [{ ok: false }, /Could not resolve/],
    [{ ok: true }, /No ChatGPT OAuth token/],
  ]) {
    await assert.rejects(fetchCodexUsage({
      model: { provider: "openai-codex" },
      modelRegistry: { getApiKeyAndHeaders: async () => auth },
    }, options), message);
  }
});

test("an already aborted request does not resolve credentials or fetch", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(fetchCodexUsage({
    model: { provider: "openai-codex" },
    modelRegistry: { getApiKeyAndHeaders: () => assert.fail("resolved credentials") },
  }, {
    signal: controller.signal,
    fetchImpl: () => assert.fail("fetched usage"),
  }), /cancelled/);
});

test("cancellation stops waiting for auth and prevents a late usage request", async () => {
  const controller = new AbortController();
  let resolveAuth;
  let settled = false;
  const pending = fetchCodexUsage({
    model: { provider: "openai-codex" },
    modelRegistry: {
      getApiKeyAndHeaders: () => new Promise((resolve) => { resolveAuth = resolve; }),
    },
  }, {
    signal: controller.signal,
    fetchImpl: () => assert.fail("fetched usage after cancellation"),
  });
  const rejection = assert.rejects(pending, /cancelled/).then(() => { settled = true; });
  controller.abort(new Error("cancelled"));
  await new Promise((resolve) => setImmediate(resolve));
  // Resolve even on the old implementation so the test leaves no pending work.
  const settledBeforeAuth = settled;
  resolveAuth({ ok: true, apiKey: "opaque" });
  await rejection;
  assert.equal(settledBeforeAuth, true, "auth must not hold the caller after cancellation");
});

test("cancels unused HTTP error bodies", async () => {
  let cancelled = false;
  const ctx = {
    model: { provider: "openai-codex", id: "gpt-5.4" },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "opaque" };
      },
    },
  };

  await assert.rejects(
    fetchCodexUsage(ctx, {
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() { cancelled = true; },
      }), { status: 429 }),
    }),
    /ChatGPT usage request failed \(429\)/,
  );
  assert.equal(cancelled, true);
});

test("rejects API payloads without recognized windows", async () => {
  const ctx = {
    model: { provider: "openai-codex", id: "gpt-5.4" },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "opaque" };
      },
    },
  };

  await assert.rejects(
    fetchCodexUsage(ctx, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { rate_limit: {} };
        },
      }),
    }),
    /no recognized usage windows/i,
  );
});
