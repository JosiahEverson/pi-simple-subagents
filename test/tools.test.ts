import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterToolSelection } from "../shared/tools.ts";

const delegatedNames = ["spawn_subagent", "message_subagent", "get_scoped_models"];

describe("worker tool selection", () => {
  it("preserves all effective tools after extension filtering", () => {
    assert.deepEqual(
      filterToolSelection(["read", ...delegatedNames], "all"),
      { selected: ["read", ...delegatedNames], warnings: [] },
    );
  });

  it("allows explicit selection of same-named tools owned by another extension", () => {
    assert.deepEqual(
      filterToolSelection(delegatedNames, ["spawn_subagent", "get_scoped_models"]),
      { selected: ["spawn_subagent", "get_scoped_models"], warnings: [] },
    );
  });
});
