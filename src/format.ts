import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  MAX_FIVE_HOUR_RESET_SECONDS,
  MAX_MODEL_WIDTH,
  MAX_WEEK_RESET_SECONDS,
} from "./constants.ts";
import type { QuotaLabel, UsageWindow } from "./types.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function sanitizeSingleLine(value: unknown): string {
  // Extension statuses may contain colors, but must not move the cursor,
  // clear the screen, or issue OSC commands (e.g. clipboard writes).
  return String(value ?? "")
    .split(/(\u001b\[[0-9;:]*m)/g)
    .map((part, index) => index % 2 ? part : stripVTControlCharacters(part)
      .replace(/[\r\n\t\u2028\u2029]/g, " ")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ""))
    .join("")
    .replace(/ +/g, " ")
    .trim();
}

export function shortenMiddle(value: unknown, maxWidth: number): string {
  const text = sanitizeSingleLine(stripVTControlCharacters(String(value ?? "")));
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return "…";

  const characters = Array.from(segmenter.segment(text), ({ segment }) => segment);
  let leftBudget = Math.ceil((maxWidth - 1) / 2);
  let rightBudget = Math.floor((maxWidth - 1) / 2);
  let left = "";
  let right = "";
  for (const character of characters) {
    const width = visibleWidth(character);
    if (width > leftBudget) break;
    left += character;
    leftBudget -= width;
  }
  for (const character of characters.reverse()) {
    const width = visibleWidth(character);
    if (width > rightBudget) break;
    right = character + right;
    rightBudget -= width;
  }
  return `${left}…${right}`;
}

function titleCaseToken(token: string): string {
  const upper = new Set(["api", "oss", "o1", "o3", "o4"]);
  if (upper.has(token.toLowerCase())) return token.toUpperCase();
  return token ? token.charAt(0).toUpperCase() + token.slice(1) : token;
}

export function formatModelName(
  modelId: string | undefined,
  maxWidth = MAX_MODEL_WIDTH,
): string {
  let id = sanitizeSingleLine(stripVTControlCharacters(String(modelId ?? "")));
  id = id.slice(id.lastIndexOf("/") + 1);

  const match = /^gpt-([0-9]+(?:\.[0-9]+)?)(?:-(.+))?$/i.exec(id);
  if (match) {
    const suffixParts = (match[2] || "")
      .split("-")
      .filter((part) => part && !["codex", "latest"].includes(part.toLowerCase()));
    const suffix = suffixParts.length
      ? ` ${suffixParts.map(titleCaseToken).join(" ")}`
      : "";
    id = `GPT-${match[1]}${suffix}`;
  } else if (/^codex-/i.test(id)) {
    id = id
      .split("-")
      .filter((part) => part.toLowerCase() !== "latest")
      .map(titleCaseToken)
      .join(" ");
  }

  return shortenMiddle(id, maxWidth);
}

export function clampPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.floor(Math.max(0, Math.min(100, value)));
}

export function effectiveUsedPercent(
  window: UsageWindow | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (!window) return undefined;
  if (
    typeof window.resetAt === "number" &&
    Number.isFinite(window.resetAt) &&
    window.resetAt * 1000 <= nowMs
  ) {
    return 0;
  }
  return clampPercent(window.usedPercent);
}

export function formatResetCountdown(
  resetAt: number | undefined,
  maxSeconds: number,
  nowMs = Date.now(),
): string | undefined {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return undefined;

  const secondsLeft = resetAt - nowMs / 1000;
  if (secondsLeft <= 0 || secondsLeft > maxSeconds) return undefined;

  const totalMinutes = Math.ceil(secondsLeft / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (totalHours >= 24) {
    return `${Math.floor(totalHours / 24)}d${totalHours % 24}h`;
  }
  return `${totalHours}h${String(minutes).padStart(2, "0")}m`;
}

export function formatWindowCountdown(
  label: QuotaLabel,
  window: UsageWindow | undefined,
  nowMs = Date.now(),
): string | undefined {
  const maxSeconds =
    label === "5h"
      ? MAX_FIVE_HOUR_RESET_SECONDS
      : MAX_WEEK_RESET_SECONDS;
  return formatResetCountdown(window?.resetAt, maxSeconds, nowMs);
}
