# Worked examples

Replace `<package-root>` with the installed package path (see workflow-patterns.md "Lifecycle").

## Batch review of TSV rows

The canonical batch case: N rows, one shared rubric, structured verdicts, one aggregated report. The rubric lives in a script constant — workers never read a shared spec file.

```ts
// /tmp/review-sessions.ts — run: npx tsx /tmp/review-sessions.ts
import { readFileSync } from "node:fs";
import { createWorkflowRuntime } from "<package-root>/workflow/index.ts";

const RUBRIC = `
You are reviewing one AI session for success-story potential.
A session qualifies if: the user goal is clear, the agent completed it
without human rescue, and the result is demonstrably correct.
Judge only the session you are given.
`.trim();

const rows = readFileSync("/tmp/session-prompts.tsv", "utf8")
  .trim().split("\n").slice(1)
  .map((line) => {
    const [id, , , , sessionPath, prompt] = line.split("\t");
    return { id, sessionPath, prompt };
  });

const wf = await createWorkflowRuntime({
  budget: { maxTotalAgents: rows.length + 1 },
});

wf.phase(`Reviewing ${rows.length} sessions`);
type Row = (typeof rows)[number] & { verdict?: { qualifies: boolean; summary: string } };

const reviewed = await wf.pipeline(
  rows as Row[],
  async (row) => ({
    ...row,
    verdict: (await wf.agent<{ qualifies: boolean; summary: string }>(
      `${RUBRIC}\n\nSession ID: ${row.id}\nSession file: ${row.sessionPath}\nFirst user prompt: ${row.prompt}\n\nRead the session file and judge it.`,
      {
        thinking: "low",
        tools: ["read", "bash"],
        label: `row-${row.id}`,
        schema: {
          type: "object",
          required: ["qualifies", "summary"],
          properties: {
            qualifies: { type: "boolean" },
            summary: { type: "string" },
          },
        },
      },
    )).output,
  }),
);

const hits = reviewed.filter((r) => r.verdict?.qualifies);
wf.log(`${hits.length}/${rows.length} qualify`);

const report = await wf.agent(
  `Write a ranked summary of these qualifying sessions:\n\n${hits
    .map((h) => `- ${h.id}: ${h.verdict?.summary}`)
    .join("\n")}`,
  { thinking: "high", tools: [], label: "report" },
);
console.log(report.output);
console.log(JSON.stringify(wf.budget.totals));
```

## Multi-perspective research with synthesis

```ts
// /tmp/research.ts
import { createWorkflowRuntime } from "<package-root>/workflow/index.ts";

const wf = await createWorkflowRuntime({
  budget: { maxTotalAgents: 5, maxTotalCost: 2.0 },
  args: { topic: "adopting server components" },
});
const topic = String(wf.args.topic);

const briefs = await wf.parallel([
  () => wf.agent(`Research ${topic}: official documentation and design intent. Cite sources. Write findings to /tmp/research-official.md; reply with a 10-line summary.`, { label: "official" }),
  () => wf.agent(`Research ${topic}: practitioner failure reports and criticism only. Distinct from official docs. Cite sources. Write to /tmp/research-critics.md; reply with a 10-line summary.`, { label: "critics" }),
  () => wf.agent(`Research ${topic}: migration case studies with concrete outcomes. Write to /tmp/research-cases.md; reply with a 10-line summary.`, { label: "cases" }),
]);

const synthesis = await wf.agent(
  `Synthesize a recommendation on ${topic} from these summaries. Note where they conflict:\n\n${briefs.map((b) => b.output).join("\n---\n")}`,
  { thinking: "high", tools: [] },
);
console.log(synthesis.output);
```

Workers write full briefs to files and return short summaries — the synthesis stage and your context handle only compact text.

## Adversarial verification of findings

```ts
// After a discovery stage produced `findings: { file: string; claim: string }[]`
const verdicts = await wf.pipeline(
  findings.map((f) => ({ ...f, upheld: false })),
  async (f) => ({
    ...f,
    upheld: (await wf.agent<{ verdict: string }>(
      `Attempt to refute this claim about ${f.file} by reading the code. Be adversarial; a claim survives only if you fail to break it.\n\nClaim: ${f.claim}`,
      {
        thinking: "high",
        tools: ["read", "grep", "bash"],
        label: `refute-${f.file}`,
        schema: { type: "object", required: ["verdict"], properties: { verdict: { type: "string", enum: ["UPHELD", "REFUTED"] } } },
      },
    )).output.verdict === "UPHELD",
  }),
);
console.log(verdicts.filter((v) => v.upheld));
```
