const baseUrl =
    process.env.PI_CODEX_STATUSLINE_BASE_URL ||
    "https://chatgpt.com/backend-api";

export const USAGE_URL = `${baseUrl.replace(/\/+$/, "")}/wham/usage`;

export const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

export const FIVE_HOUR_SECONDS = 5 * 60 * 60;
export const WEEK_SECONDS = 7 * 24 * 60 * 60;
export const MAX_FIVE_HOUR_RESET_SECONDS = 6 * 60 * 60;
export const MAX_WEEK_RESET_SECONDS = 8 * 24 * 60 * 60;

export const CONTEXT_WARN_PERCENT = 75;
export const CONTEXT_CRITICAL_PERCENT = 85;
export const QUOTA_WARN_PERCENT = 75;
export const QUOTA_CRITICAL_PERCENT = 90;

export const COUNTDOWN_TICK_MS = 60_000;
export const USAGE_POLL_MS = 60_000;
export const USAGE_TIMEOUT_MS = 15_000;
export const MAX_MODEL_WIDTH = 18;
