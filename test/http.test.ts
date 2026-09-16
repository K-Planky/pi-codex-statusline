import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import test, { type TestContext } from "node:test";
import { authContext, deferred } from "./helpers.ts";

import { fetchCodexUsage } from "../src/usage.ts";

const ctx = authContext(async () => ({ ok: true, apiKey: "test-token" }));

async function serve(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/usage`;
}

test("real fetch refuses redirects rather than forwarding credentials", async (t) => {
  const paths: (string | undefined)[] = [];
  const endpoint = await serve(t, (request, response) => {
    paths.push(request.url);
    response.writeHead(302, { location: "/redirect-target" });
    response.end();
  });

  await assert.rejects(fetchCodexUsage(ctx, { endpoint }), /fetch failed/);
  assert.deepEqual(paths, ["/usage"]);
});

test("real fetch can abort an unfinished response", async (t) => {
  const started = deferred<void>();
  const endpoint = await serve(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"rate_limit":');
    started.resolve();
  });
  const controller = new AbortController();
  const pending = fetchCodexUsage(ctx, { endpoint, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await started.promise;
  controller.abort();
  await rejected;
});
