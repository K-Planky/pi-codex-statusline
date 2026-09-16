import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  effectiveUsedPercent,
  formatModelName,
  formatResetCountdown,
  shortenMiddle,
  sanitizeSingleLine,
} from "../src/format.js";

test("formats Codex model ids as compact display names", () => {
  assert.equal(formatModelName("gpt-5.4"), "GPT-5.4");
  assert.equal(formatModelName("gpt-5.3-codex-spark"), "GPT-5.3 Spark");
  assert.equal(formatModelName("codex-mini-latest"), "Codex Mini");
});

test("middle shortening keeps both identifying ends", () => {
  assert.equal(shortenMiddle("ABC-1234-a-long-name", 12), "ABC-12…-name");
  assert.equal(shortenMiddle("short", 12), "short");
  assert.equal(shortenMiddle("abc", 1), "…");
});

test("middle shortening measures terminal columns and preserves graphemes", () => {
  for (const text of ["模型模型模型模型", "👩‍💻👩‍💻👩‍💻👩‍💻", "e\u0301e\u0301e\u0301e\u0301"]) {
    for (let width = 0; width <= 12; width++) {
      assert.ok(visibleWidth(shortenMiddle(text, width)) <= width);
    }
  }
  assert.equal(shortenMiddle("e\u0301e\u0301e\u0301e\u0301", 3), "e\u0301…e\u0301");
  assert.equal(shortenMiddle("👩‍💻👩‍💻👩‍💻👩‍💻", 5), "👩‍💻…👩‍💻");
});

test("single-line sanitization preserves colors but removes terminal commands", () => {
  assert.equal(
    sanitizeSingleLine("\u001b[31mready\u001b[0m\u001b[2J\u001b[10B\u0007\b\u001b]52;c;YWJj\u0007\nnext\tline"),
    "\u001b[31mready\u001b[0m next line",
  );
  assert.equal(formatModelName("\u001b[31mgpt-5.4\u001b[0m"), "GPT-5.4");
});

test("reset countdowns round up and switch to day notation", () => {
  const now = 1_700_000_000_000;
  assert.equal(formatResetCountdown(now / 1000 + 30, 3600, now), "0h01m");
  assert.equal(
    formatResetCountdown(now / 1000 + 86_399, 100_000, now),
    "1d0h",
  );
  assert.equal(formatResetCountdown(now / 1000 - 1, 3600, now), undefined);
  assert.equal(
    formatResetCountdown(now / 1000 + 3601, 3600, now),
    undefined,
  );
});

test("an expired usage window reads zero percent", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    effectiveUsedPercent({ usedPercent: 91, resetAt: now / 1000 - 1 }, now),
    0,
  );
  assert.equal(effectiveUsedPercent({ usedPercent: 42.9 }, now), 42);
});
