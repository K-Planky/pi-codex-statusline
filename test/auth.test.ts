import assert from "node:assert/strict";
import test from "node:test";

import { getAccountId, isChatGPTLogin } from "../src/auth.ts";

import { createContext, createModel } from "./helpers.ts";

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

test("only enables quotas for the openai OAuth login", () => {
  const ctx = createContext();
  assert.equal(isChatGPTLogin(ctx), true);
  ctx.modelRegistry.isUsingOAuth = () => false;
  assert.equal(isChatGPTLogin(ctx), false);
  ctx.modelRegistry.isUsingOAuth = () => true;
  for (const provider of ["openai-codex", "openai-codex-2", "openai-2", "anthropic"]) {
    ctx.model = createModel({ provider });
    assert.equal(isChatGPTLogin(ctx), false);
  }
  ctx.model = undefined;
  assert.equal(isChatGPTLogin(ctx), false);
});

test("reads the account id from a ChatGPT OAuth token", () => {
  const token = `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_test",
    },
  })}.`;

  assert.equal(getAccountId(token), "acct_test");
});

test("opaque and malformed tokens have no account id", () => {
  assert.equal(getAccountId("opaque-token"), undefined);
  assert.equal(getAccountId("a.not-json.c"), undefined);
});
