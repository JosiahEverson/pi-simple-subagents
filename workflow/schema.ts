import type { UsageSummary } from "../shared/messages.ts";

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
  parsed?: unknown;
}

export class SchemaValidationError extends Error {
  constructor(
    public readonly errors: string[],
    public readonly agentId?: string,
    public readonly task?: string,
    public readonly usage?: UsageSummary,
  ) {
    super(`Agent output failed schema validation: ${errors.join("; ")}`);
    this.name = "SchemaValidationError";
  }
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
}

const SUPPORTED_KEYWORDS = new Set(["type", "properties", "required", "items", "enum"]);
const SUPPORTED_TYPES = new Set(["null", "array", "object", "integer", "number", "string", "boolean"]);

export function assertSupportedSchema(schema: object): asserts schema is JsonSchema {
  validateSchemaNode(schema, "$schema");
}

export function canonicalizeSchema(schema: object): string {
  assertSupportedSchema(schema);
  return JSON.stringify(sortJson(schema));
}

export function appendSchemaInstruction(prompt: string, schema: object): string {
  return `${prompt}\n\nReply with a single JSON value matching this JSON Schema exactly — no prose, no code fences:\n${JSON.stringify(schema, null, 2)}`;
}

export function validateOutput(raw: string, schema: object): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { valid: false, errors: [`JSON parse error: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const errors: string[] = [];
  validateValue(parsed, schema as JsonSchema, "$", errors);
  return errors.length === 0 ? { valid: true, parsed } : { valid: false, errors, parsed };
}

export function shouldRetry(result: ValidationResult, attempt: number, maxRetries: number): boolean {
  return !result.valid && attempt < maxRetries;
}

export function buildCorrectionPrompt(errors: string[], schema: object): string {
  return `Your reply did not match the required schema. Errors:\n${errors.map((error) => `- ${error}`).join("\n")}\n\nReply again with only a single JSON value matching the schema exactly — no prose, no code fences:\n${JSON.stringify(schema, null, 2)}`;
}

function validateSchemaNode(value: unknown, path: string): asserts value is JsonSchema {
  if (!isRecord(value)) throw new Error(`Invalid JSON Schema at ${path}: expected an object.`);
  for (const keyword of Object.keys(value)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`Unsupported JSON Schema keyword "${keyword}" at ${path}. Supported keywords: type, properties, required, items, enum.`);
    }
  }
  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (types.length === 0 || types.some((type) => typeof type !== "string" || !SUPPORTED_TYPES.has(type))) {
      throw new Error(`Invalid JSON Schema at ${path}.type: expected a supported type or non-empty array of supported types.`);
    }
  }
  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) throw new Error(`Invalid JSON Schema at ${path}.properties: expected an object.`);
    for (const [name, child] of Object.entries(value.properties)) validateSchemaNode(child, `${path}.properties.${name}`);
  }
  if (value.required !== undefined &&
      (!Array.isArray(value.required) || value.required.some((name) => typeof name !== "string"))) {
    throw new Error(`Invalid JSON Schema at ${path}.required: expected an array of strings.`);
  }
  if (value.items !== undefined) validateSchemaNode(value.items, `${path}.items`);
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.some((item) => !isJsonValue(item))) {
      throw new Error(`Invalid JSON Schema at ${path}.enum: expected an array of JSON values.`);
    }
  }
}

function validateValue(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${path}: expected ${types.join(" or ")}`);
      return;
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(record, required)) errors.push(`${path}.${required}: is required`);
    }
    for (const [name, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(record, name)) validateValue(record[name], childSchema, `${path}.${name}`, errors);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateValue(item, schema.items!, `${path}[${index}]`, errors));
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    default: return false;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}
