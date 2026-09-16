import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { UsageWindow } from "../src/types.ts";

/** Only host APIs used by a test are supplied; supplied members remain type-checked. */
export function mockHost<T extends object>(members: Partial<T>): T {
  return members as T;
}

export function required<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null, "Expected a fixture value to exist");
  return value;
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export type AuthResult = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
export type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
export type FooterComponent = ReturnType<FooterFactory>;

export function createModel(overrides: Partial<NonNullable<ExtensionContext["model"]>> = {}) {
  return {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  } satisfies NonNullable<ExtensionContext["model"]>;
}

export function contextUsage(percent: number | null) {
  return { percent, tokens: percent === null ? null : percent * 2000, contextWindow: 200_000 };
}

export function createContext(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
  return mockHost<ExtensionCommandContext>({
    mode: "tui",
    model: createModel(),
    thinkingLevel: "high",
    getContextUsage: () => contextUsage(20),
    modelRegistry: mockHost<ExtensionContext["modelRegistry"]>({
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "opaque-token" }),
    }),
    ui: mockHost<ExtensionContext["ui"]>({}),
    ...overrides,
  });
}

export function authContext(resolveAuth: ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]) {
  return createContext({
    modelRegistry: mockHost<ExtensionContext["modelRegistry"]>({ getApiKeyAndHeaders: resolveAuth }),
  });
}

export function usageWindow(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return { usedPercent: 0, windowSeconds: 18_000, resetAt: undefined, ...overrides };
}

export const plainTheme = mockHost<Theme>({ fg: (_color, text) => text });
export const emptyFooterData: ReadonlyFooterDataProvider = {
  getExtensionStatuses: () => new Map<string, string>(),
  getGitBranch: () => null,
  getAvailableProviderCount: () => 1,
  onBranchChange: () => () => {},
};

export function createFooter(factory: FooterFactory, requestRender = () => {}): FooterComponent {
  return factory(mockHost<Parameters<FooterFactory>[0]>({ requestRender }), plainTheme, emptyFooterData);
}

export const thinkingAPI = mockHost<ExtensionAPI>({ getThinkingLevel: () => "high" });

export interface FakeTimer {
  callback: () => void;
  delay: number | undefined;
  unrefCalls: number;
  unref(): void;
}

/** Deliberately exposes callbacks, including cleared ones, to test stale-timer races. */
export function useFakeTimers(t: TestContext) {
  const timers: FakeTimer[] = [];
  const clearedTimers: FakeTimer[] = [];
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay?: number) => {
    const timer: FakeTimer = {
      callback, delay, unrefCalls: 0,
      unref() { this.unrefCalls++; },
    };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer: FakeTimer) => {
    clearedTimers.push(timer);
  });
  return { timers, clearedTimers };
}
