import { ProcedureSchema, type Procedure } from "./procedure.js";
type Trace = { trace_id: string; steps: unknown[]; snapshots: Array<{ url: string; timestamp: number; nodes: Array<{ role: string; accessible_name: string }> }>; notes: unknown[] };

const prompt = `You are Understudy's Compiler. Convert a browser trace into one durable Procedure JSON object. Return JSON only. Capture intent, not clicks. Remove scroll/focus/redundancy and merge incidental menu clicks. Identify credentials, dates, search terms, and note-marked values as inputs; password values are secret inputs. Identify reads/copies as extract steps. Describe targets semantically, never with selectors, colours, or positions. Every step needs a verifiable expected_page. Mark cookie banners/modals optional. The JSON must have procedure_id, name, description, starting_url, inputs, steps, outputs. Steps have intent, action, target_description, target_hints, expected_page, optional, and when applicable value_source or extract.`;

function context(trace: Trace): string { return JSON.stringify({ trace_id: trace.trace_id, steps: trace.steps, snapshots: trace.snapshots.map((item) => ({ ...item, nodes: item.nodes.map((node) => `${node.role}: ${node.accessible_name}`) })), notes: trace.notes }); }
async function callOpenAI(input: string, repair?: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured on the server.");
  const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: "gpt-5.6", input: [{ role: "system", content: prompt }, { role: "user", content: `${repair ?? ""}\n${input}` }], text: { format: { type: "json_object" } } }) });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { error?: { message?: string; type?: string; code?: string } } | null;
    const detail = failure?.error?.message ?? "No additional error detail was returned by OpenAI.";
    const code = failure?.error?.code ? ` [${failure.error.code}]` : "";
    throw new Error(`OpenAI request failed (${response.status})${code}: ${detail}`);
  }
  const body = await response.json() as {
    output_text?: string;
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  };
  const nestedText = body.output?.flatMap((item) => item.content ?? []).filter((item) => item.type === "output_text" && typeof item.text === "string").map((item) => item.text!).join("");
  const output = body.output_text ?? nestedText;
  if (!output) throw new Error("OpenAI returned no compiler output. Check the server logs for the raw response status.");
  return output;
}
export async function compileTrace(trace: Trace): Promise<Procedure> { const input = context(trace); let raw = await callOpenAI(input); for (let attempt = 0; attempt < 2; attempt += 1) { try { return ProcedureSchema.parse(JSON.parse(raw)); } catch (error) { console.warn("Compiler validation failure", { attempt, error }); raw = await callOpenAI(input, `Repair invalid procedure JSON. Validation error: ${error instanceof Error ? error.message : String(error)}. Return JSON only.`); } } throw new Error("Compiler output did not validate after repair."); }
