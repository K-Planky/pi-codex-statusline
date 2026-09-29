import assert from "node:assert/strict";
import test from "node:test";

import { fetchCodexUsage, parseUsageResponse } from "../src/usage.ts";
import { authContext, createContext, createModel, deferred, required, type AuthResult } from "./helpers.ts";

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeToken(payload: unknown) {
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

  assert.equal(required(snapshot.fiveHour).usedPercent, 25.9);
  assert.equal(required(snapshot.weekly).usedPercent, 42.2);
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
  // Construct malformed wire data directly: the parser intentionally accepts unknown.
  const payload = {
    rate_limit: {
      primary_window: { ...usagePayload().rate_limit.primary_window, reset_at: "bad" },
    },
  };
  assert.equal(required(parseUsageResponse(payload).fiveHour).resetAt, undefined);
});

test("fetches usage with Pi's OAuth token and account header", async () => {
  const token = fakeToken({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_test",
    },
  });
  const ctx = authContext(async (provider) => {
    assert.equal(provider, "openai-codex", "only the legacy quota credential is resolved");
    return { auth: { apiKey: token, headers: { "x-test": "yes" } } };
  });
  ctx.modelRegistry.getApiKeyAndHeaders = async () => assert.fail("resolved active model token");

  const snapshot = await fetchCodexUsage(ctx, {
    endpoint: "https://example.test/usage",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://example.test/usage");
      const headers = new Headers(required(options).headers);
      assert.equal(headers.get("authorization"), `Bearer ${token}`);
      assert.equal(headers.get("chatgpt-account-id"), "acct_test");
      assert.equal(headers.get("x-test"), null);
      assert.equal(required(options).redirect, "error");
      return Response.json(usagePayload());
    },
  });

  assert.equal(required(snapshot.fiveHour).usedPercent, 25.9);
  assert.equal(required(snapshot.weekly).usedPercent, 42.2);
});

test("rejects unsupported providers and unavailable credentials without fetching", async () => {
  const options = { fetchImpl: () => assert.fail("unexpected fetch") };
  await assert.rejects(fetchCodexUsage(createContext({ model: createModel({ provider: "openai-codex" }) }), options),
    /not using the openai ChatGPT login/);
  for (const auth of [undefined, { auth: {} }]) {
    await assert.rejects(fetchCodexUsage(authContext(async () => auth), options), /No legacy ChatGPT OAuth token/);
  }
  await assert.rejects(fetchCodexUsage(authContext(async () => {
    throw new Error("auth unavailable");
  }), options), /auth unavailable/);
});

test("an already aborted request does not resolve credentials or fetch", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(fetchCodexUsage(
    authContext(() => assert.fail("resolved credentials")),
    {
      signal: controller.signal,
      fetchImpl: () => assert.fail("fetched usage"),
    },
  ), /cancelled/);
});

test("cancellation stops waiting for auth and prevents a late usage request", async () => {
  const controller = new AbortController();
  const auth = deferred<AuthResult>();
  let settled = false;
  const pending = fetchCodexUsage(authContext(() => auth.promise), {
    signal: controller.signal,
    fetchImpl: () => assert.fail("fetched usage after cancellation"),
  });
  const rejection = assert.rejects(pending, /cancelled/).then(() => { settled = true; });
  controller.abort(new Error("cancelled"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  // Resolve even on the old implementation so the test leaves no pending work.
  const settledBeforeAuth = settled;
  auth.resolve({ auth: { apiKey: "opaque" } });
  await rejection;
  assert.equal(settledBeforeAuth, true, "auth must not hold the caller after cancellation");
});

test("cancels unused HTTP error bodies", async () => {
  let cancelled = false;
  const ctx = authContext(async () => ({ auth: { apiKey: "opaque" } }));

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
  const ctx = authContext(async () => ({ auth: { apiKey: "opaque" } }));

  await assert.rejects(
    fetchCodexUsage(ctx, {
      fetchImpl: async () => Response.json({ rate_limit: {} }),
    }),
    /no recognized usage windows/i,
  );
});


test("OpenAI API-key mode does not resolve a quota credential or make a request", async () => {
  const ctx = authContext(async () => assert.fail("resolved quota credential"));
  ctx.modelRegistry.isUsingOAuth = () => false;
  await assert.rejects(fetchCodexUsage(ctx, {
    fetchImpl: async () => assert.fail("fetched quota"),
  }), /not using the openai ChatGPT login/);
});
