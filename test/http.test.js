import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { fetchCodexUsage } from "../src/usage.js";

const ctx = {
  model: { provider: "openai-codex", id: "gpt-5.4" },
  modelRegistry: {
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-token" }),
  },
};

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}/usage`;
}

test("real fetch refuses redirects rather than forwarding credentials", async (t) => {
  const paths = [];
  const endpoint = await serve(t, (request, response) => {
    paths.push(request.url);
    response.writeHead(302, { location: "/redirect-target" });
    response.end();
  });

  await assert.rejects(fetchCodexUsage(ctx, { endpoint }), /fetch failed/);
  assert.deepEqual(paths, ["/usage"]);
});

test("real fetch can abort an unfinished response", async (t) => {
  let bodyStarted;
  const started = new Promise((resolve) => { bodyStarted = resolve; });
  const endpoint = await serve(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"rate_limit":');
    bodyStarted();
  });
  const controller = new AbortController();
  const pending = fetchCodexUsage(ctx, { endpoint, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await started;
  controller.abort();
  await rejected;
});
