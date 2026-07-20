import { ProcedureSchema, type Procedure } from "../procedure";
import type { Trace } from "../types";
import compilerPrompt from "../prompts/compiler.md?raw";

const API_URL = "https://api.openai.com/v1/responses";

function traceContext(trace: Trace): string {
  const screenshots = new Map(trace.screenshots.map((item) => [item.step_index, item.data_url]));
  return JSON.stringify({
    trace_id: trace.trace_id, started_at: trace.started_at, ended_at: trace.ended_at,
    steps: trace.steps.map((step) => ({ ...step, screenshot: step.target.accessible_name ? undefined : screenshots.get(step.index) })),
    snapshots: trace.snapshots.map((snapshot) => ({ url: snapshot.url, timestamp: snapshot.timestamp, nodes: snapshot.nodes.map((node) => `${node.role}: ${node.accessible_name} [${node.reference_id}]`) })),
    notes: trace.notes
  });
}

async function request(apiKey: string, userText: string, repair?: string): Promise<string> {
  const response = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: "gpt-5.6", input: [{ role: "system", content: compilerPrompt }, { role: "user", content: repair ? `${repair}\n\n${userText}` : userText }], text: { format: { type: "json_object" } } }) });
  if (!response.ok) throw new Error(`OpenAI request failed (${response.status}): ${await response.text()}`);
  const payload = await response.json() as { output_text?: string };
  if (!payload.output_text) throw new Error("OpenAI returned no text output.");
  return payload.output_text;
}

export async function compileTrace(trace: Trace, apiKey: string): Promise<Procedure> {
  const context = traceContext(trace);
  let output = await request(apiKey, context);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return ProcedureSchema.parse(JSON.parse(output)); }
    catch (error) {
      console.warn("Understudy compiler validation failed", { attempt, error });
      output = await request(apiKey, context, `Your prior JSON failed Zod validation: ${error instanceof Error ? error.message : String(error)}. Repair it. Return only a complete valid Procedure JSON object.`);
    }
  }
  throw new Error("The compiler could not produce a valid procedure after two repairs.");
}
