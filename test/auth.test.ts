import assert from "node:assert/strict";
import test from "node:test";

import { getAccountId, isCodexProvider } from "../src/auth.ts";

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

test("recognizes Codex providers, including numbered accounts", () => {
  assert.equal(isCodexProvider("openai-codex"), true);
  assert.equal(isCodexProvider("openai-codex-2"), true);
  assert.equal(isCodexProvider("openai"), false);
  assert.equal(isCodexProvider(undefined), false);
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
