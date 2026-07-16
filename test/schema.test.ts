import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSupportedSchema, buildCorrectionPrompt, shouldRetry, validateOutput } from "../workflow/schema.ts";

const schema = {
  type: "object",
  properties: { name: { type: "string" }, tags: { type: "array", items: { enum: ["a", "b"] } } },
  required: ["name"],
};

describe("schema output", () => {
  it("accepts valid JSON matching the schema", () => {
    const result = validateOutput('{"name":"ok","tags":["a"]}', schema);
    assert.equal(result.valid, true);
    assert.deepEqual(result.parsed, { name: "ok", tags: ["a"] });
  });

  it("reports invalid JSON as a parse error", () => {
    const result = validateOutput("not json", schema);
    assert.equal(result.valid, false);
    assert.match(result.errors![0]!, /parse error/i);
  });

  it("reports schema violations with paths", () => {
    const result = validateOutput('{"tags":["wrong"]}', schema);
    assert.equal(result.valid, false);
    assert.ok(result.errors!.some((error) => error.includes("$.name")));
    assert.ok(result.errors!.some((error) => error.includes("$.tags[0]")));
  });

  it("retries only below the maximum", () => {
    const invalid = { valid: false, errors: ["bad"] };
    assert.equal(shouldRetry(invalid, 0, 2), true);
    assert.equal(shouldRetry(invalid, 2, 2), false);
    assert.equal(shouldRetry({ valid: true }, 0, 2), false);
  });

  it("includes validation details in correction prompts", () => {
    assert.match(buildCorrectionPrompt(["$.name: is required"], schema), /\$\.name: is required/);
  });

  it("rejects unsupported schema keywords up front", () => {
    assert.throws(
      () => assertSupportedSchema({ type: "object", additionalProperties: false }),
      /Unsupported JSON Schema keyword "additionalProperties"/,
    );
  });
});
