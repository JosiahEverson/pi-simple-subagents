import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSpec } from "../shared/spec.ts";

const context = {
  parentModelId: "parent/model",
  parentThinking: "low" as const,
  defaultModel: "default/model",
  defaultThinking: "high" as const,
};

describe("resolveSpec", () => {
  it("uses model and thinking precedence", () => {
    const explicit = resolveSpec({ task: "work", model: "arg/model", thinking: "max" }, context);
    assert.equal(explicit.modelId, "arg/model");
    assert.equal(explicit.thinking, "max");
    const defaults = resolveSpec({ task: "work" }, context);
    assert.equal(defaults.modelId, "default/model");
    assert.equal(defaults.thinking, "high");
    const parent = resolveSpec({ task: "work" }, {
      parentModelId: "parent/model", parentThinking: "minimal",
    });
    assert.equal(parent.modelId, "parent/model");
    assert.equal(parent.thinking, "minimal");
  });

  it("derives and sanitizes labels, including whitespace labels", () => {
    assert.equal(resolveSpec({ task: "Review API routes now" }, context).label, "Review-API-routes-no");
    assert.equal(resolveSpec({ task: "work", label: "   " }, context).label, "subagent");
  });

  it("constructs role and generic system prompts", () => {
    assert.equal(resolveSpec({ task: "work", role: "  Be exact. " }, context).systemPrompt,
      "You are a subagent.\n\nBe exact.");
    assert.equal(resolveSpec({ task: "work", role: "  " }, context).systemPrompt,
      "You are a subagent. Follow the task instructions exactly and reply with your results.");
  });

  it("normalizes omitted and explicit tool/skill selections", () => {
    const all = resolveSpec({ task: "work" }, context);
    assert.equal(all.tools, "all");
    assert.equal(all.skills, "all");
    const explicit = resolveSpec({ task: "work", tools: [], skills: ["review"] }, context);
    assert.deepEqual(explicit.tools, []);
    assert.deepEqual(explicit.skills, ["review"]);
  });

  it("falls back when model is undefined", () => {
    assert.equal(resolveSpec({ task: "work", model: undefined }, context).modelId, "default/model");
  });
});
