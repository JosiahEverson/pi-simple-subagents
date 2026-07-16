import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai/compat";

export interface UsageSummary {
  assistantTurns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export function emptyUsage(): UsageSummary {
  return {
    assistantTurns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function isAssistantMessage(value: unknown): value is AssistantMessage {
  return !!value && typeof value === "object" &&
    (value as { role?: unknown }).role === "assistant" &&
    Array.isArray((value as { content?: unknown }).content) &&
    !!(value as { usage?: unknown }).usage;
}

export function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function getFinalAssistantText(
  messages: unknown[],
  options: { preserveErrorMessage?: boolean } = {},
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isAssistantMessage(message)) {
      return extractAssistantText(message) || (options.preserveErrorMessage ? message.errorMessage ?? "" : "");
    }
  }
  return "";
}

export function summarizeUsage(messages: unknown[]): UsageSummary {
  const result = emptyUsage();
  for (const message of messages) {
    if (!isAssistantMessage(message)) continue;
    result.assistantTurns += 1;
    result.input += message.usage.input;
    result.output += message.usage.output;
    result.cacheRead += message.usage.cacheRead;
    result.cacheWrite += message.usage.cacheWrite;
    result.totalTokens += message.usage.totalTokens;
    result.cost.input += message.usage.cost.input;
    result.cost.output += message.usage.cost.output;
    result.cost.cacheRead += message.usage.cost.cacheRead;
    result.cost.cacheWrite += message.usage.cost.cacheWrite;
    result.cost.total += message.usage.cost.total;
  }
  return result;
}
