import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxToolCall,
  normalizeContext,
  type AssistantMessage,
  type Model,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { describe, expect, it } from "vitest";
import { restoreMessages, SESSION_KEEP_CHARS, SESSION_KEEP_MESSAGES, trimContext } from "../src/runtime.js";

const NOW = new Date("2026-10-08T10:00:00.000Z");
const SCREENSHOT_JSON_CHARS = 380_462;
const model: Model<"openai-responses"> = {
  id: "synthetic-openai-model",
  name: "Synthetic OpenAI model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://openai.invalid/v1",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function assistant(text: string): AssistantMessage {
  return { ...fauxAssistantMessage(text, { timestamp: 0 }), api: model.api, provider: model.provider, model: model.id };
}

function toolPair(id: string, screenshot = false): [AssistantMessage, ToolResultMessage] {
  const callId = `call_${id}|fc_${id}`;
  const name = screenshot ? "computer" : "echo";
  const call: AssistantMessage = {
    ...assistant(""),
    content: [fauxToolCall(name, screenshot ? { action: "screenshot" } : { text: id }, { id: callId })],
    stopReason: "toolUse",
  };
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: callId,
    toolName: name,
    content: [{ type: "text", text: screenshot ? "Computer screenshot" : `echo:${id}` }],
    isError: false,
    timestamp: 0,
  };
  if (screenshot) {
    // Match the reported result's serialized size using synthetic data only.
    const image = { type: "image" as const, mimeType: "image/png", data: "" };
    result.content.push(image);
    image.data = "A".repeat(SCREENSHOT_JSON_CHARS - JSON.stringify(result).length);
  }
  return [call, result];
}

function completedTurn(id: string, screenshot = false): AgentMessage[] {
  return [user(`Earlier request ${id}`), ...toolPair(id, screenshot), assistant(`Finished ${id}`)];
}

function withoutSystem(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => message.role !== "system");
}

function expectSummary(message: AgentMessage | undefined): void {
  expect(message?.role).toBe("user");
  expect(JSON.stringify(message?.content)).toContain("[Conversation summary]");
}

function expectValidToolHistory(messages: AgentMessage[]): void {
  const calls = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
    } else if (message.role === "toolResult") {
      expect(calls.has(message.toolCallId), `Missing earlier assistant call for ${message.toolCallId}`).toBe(true);
    }
  }

  // Exercise the public provider serializer without making a request or using credentials.
  const requestItems = convertResponsesMessages(model, normalizeContext({ messages }), new Set(["openai"]));
  const requestCalls = new Set<string>();
  let outputs = 0;
  for (const item of requestItems) {
    if (item.type === "function_call") {
      requestCalls.add(item.call_id);
    } else if (item.type === "function_call_output") {
      expect(requestCalls.has(item.call_id), `OpenAI output has no earlier function_call for ${item.call_id}`).toBe(true);
      outputs++;
    }
  }
  expect(outputs).toBe(messages.filter((message) => message.role === "toolResult").length);
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const operations = [
  { name: "restoreMessages", run: (messages: AgentMessage[], now: Date) => restoreMessages(messages, now) },
  { name: "trimContext", run: (messages: AgentMessage[], now: Date) => trimContext(messages, now) },
];

describe.each(operations)("$name preserves complete tool turns", ({ name, run }) => {
  it("retains the latest user, computer call, and oversized image result while folding an earlier turn", () => {
    const system: AgentMessage = { role: "system", content: "Current system prompt", timestamp: 0 };
    const current = [user("Inspect the computer screen"), ...toolPair("current_screenshot", true)];
    expect(JSON.stringify(current.at(-1)).length).toBe(SCREENSHOT_JSON_CHARS);
    expect(SCREENSHOT_JSON_CHARS).toBeGreaterThan(SESSION_KEEP_CHARS);

    const trimmed = run([system, ...completedTurn("old"), ...current], NOW);
    const history = withoutSystem(trimmed);
    expect(history).toHaveLength(current.length + 1);
    expectSummary(history[0]);
    expect(history.slice(1)).toEqual(current);
    expect(trimmed.filter((message) => message.role === "system")).toEqual(name === "trimContext" ? [system] : []);
    expectValidToolHistory(trimmed);
  });

  it("retains every call and result in a single current turn exceeding the message limit", () => {
    const current: AgentMessage[] = [user("Complete a long sequence of tool operations")];
    for (let i = 0; i <= SESSION_KEEP_MESSAGES / 2; i++) current.push(...toolPair(`long_${i}`));
    expect(current.length).toBeGreaterThan(SESSION_KEEP_MESSAGES);

    const trimmed = run(current, NOW);
    expect(trimmed).toEqual(current);
    expectValidToolHistory(trimmed);
  });

  it("folds older turns at user boundaries and retains recent completed turns and the latest full turn", () => {
    const older = Array.from({ length: SESSION_KEEP_MESSAGES / 2 }, (_, i) => completedTurn(`count_${i}`)).flat();
    const recent = [...completedTurn("recent_1"), ...completedTurn("recent_2")];
    const current = [user("Current request"), ...toolPair("current")];

    const trimmed = run([...older, ...recent, ...current], NOW);
    expectSummary(trimmed[0]);
    expect(trimmed[1]?.role).toBe("user");
    expect(JSON.stringify(trimmed[0]?.content)).toContain("Earlier request count_0");
    expect(trimmed.slice(1)).not.toContain(older[0]);
    expect(trimmed.slice(-(recent.length + current.length))).toEqual([...recent, ...current]);
    expect(trimmed.length).toBeLessThanOrEqual(SESSION_KEEP_MESSAGES + 1);
    expectValidToolHistory(trimmed);
  });

  it("folds an older oversized result while retaining a recent completed turn and the full latest turn", () => {
    const older = completedTurn("old_screenshot", true);
    const recent = completedTurn("recent");
    const current = [user("Continue with the recent task"), ...toolPair("latest")];

    const trimmed = run([...older, ...recent, ...current], NOW);
    expectSummary(trimmed[0]);
    expect(trimmed.slice(1)).toEqual([...recent, ...current]);
    expectValidToolHistory(trimmed);
  });

  it("keeps an already folded oversized current turn stable across repeated trimming", () => {
    const current = [user("Inspect the computer screen"), ...toolPair("repeated_screenshot", true)];
    const first = run([...completedTurn("summarized"), ...current], NOW);
    expectSummary(first[0]);
    expect(first.slice(1)).toEqual(current);

    let repeated = first;
    for (let i = 1; i <= 3; i++) {
      repeated = run(repeated, new Date(NOW.getTime() + i * 1_000));
      expect(repeated[0]).toEqual(first[0]);
      expect(repeated).toHaveLength(first.length);
      expect(repeated.slice(1)).toEqual(current);
      expectValidToolHistory(repeated);
    }
  });

  it("does not mutate the original messages or nested tool content", () => {
    const current = [user("Inspect the computer screen"), ...toolPair("immutable_screenshot", true)];
    const original = [...completedTurn("immutable_old"), ...current];
    const snapshot = structuredClone(original);
    freeze(original);

    const trimmed = run(original, NOW);
    expect(original).toEqual(snapshot);
    expect(trimmed.slice(1)).toEqual(current);
    expectValidToolHistory(trimmed);
  });
});
