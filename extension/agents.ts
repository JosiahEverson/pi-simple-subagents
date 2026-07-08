import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentSource = "builtin" | "user";
export type SelectionSpec = "all" | string[];
export type AgentContextMode = "fresh" | "fork";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentDefinition {
  name: string;
  description: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools: SelectionSpec;
  skills: SelectionSpec;
  context: AgentContextMode;
  body: string;
  source: AgentSource;
  filePath: string;
}

export interface DiscoverAgentsResult {
  agents: AgentDefinition[];
  diagnostics: string[];
}

const BUILTIN_AGENTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "agents",
);

const DEFAULT_AGENT_DIR = join(homedir(), ".pi", "agent");

export function discoverAgents(agentDir = DEFAULT_AGENT_DIR): DiscoverAgentsResult {
  const diagnostics: string[] = [];
  const byName = new Map<string, AgentDefinition>();

  for (const agent of loadAgentDirectory(BUILTIN_AGENTS_DIR, "builtin", diagnostics)) {
    byName.set(agent.name, agent);
  }

  const userAgentsDir = join(agentDir, "agents");
  for (const agent of loadAgentDirectory(userAgentsDir, "user", diagnostics)) {
    byName.set(agent.name, agent);
  }

  return {
    agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    diagnostics,
  };
}

function loadAgentDirectory(
  dir: string,
  source: AgentSource,
  diagnostics: string[],
): AgentDefinition[] {
  if (!existsSync(dir)) return [];

  const agents: AgentDefinition[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const filePath = join(dir, entry.name);
    try {
      agents.push(parseAgentFile(filePath, source));
    } catch (error) {
      diagnostics.push(
        `${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return agents;
}

function parseAgentFile(filePath: string, source: AgentSource): AgentDefinition {
  const content = readFileSync(filePath, "utf8");
  const { frontmatter, body } = parseFrontmatter(content);
  const name = requireString(frontmatter.name, "name");
  const description = requireString(frontmatter.description, "description");
  const thinking = optionalThinking(frontmatter.thinking);

  return {
    name,
    description,
    model: optionalString(frontmatter.model),
    thinking,
    tools: normalizeSelection(frontmatter.tools),
    skills: normalizeSelection(frontmatter.skills),
    context: normalizeContext(frontmatter.context),
    body,
    source,
    filePath,
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`frontmatter field "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeSelection(value: unknown): SelectionSpec {
  if (value === undefined || value === null) return "all";

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return [];
    if (trimmed.toLowerCase() === "all") return "all";
    return trimmed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }

  throw new Error("tools/skills must be a list, comma string, or \"all\"");
}

function normalizeContext(value: unknown): AgentContextMode {
  if (value === undefined || value === null || value === "") return "fresh";
  if (value === "fresh" || value === "fork") return value;
  throw new Error("context must be \"fresh\" or \"fork\"");
}

function optionalThinking(value: unknown): ThinkingLevel | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  throw new Error("thinking must be off, minimal, low, medium, high, or xhigh");
}
