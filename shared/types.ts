export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** "all" selects every available item; an array is an explicit allowlist. */
export type SelectionSpec = "all" | string[];
