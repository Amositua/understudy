import { ProcedureSchema, type Procedure } from "./procedure.js";
type Trace = { trace_id: string; steps: unknown[]; snapshots: Array<{ url: string; timestamp: number; nodes: Array<{ role: string; accessible_name: string }> }>; notes: unknown[] };

const prompt = `You are Understudy's Compiler. Convert a browser trace into one durable Procedure JSON object. Return JSON only. Capture intent, not clicks. Remove scroll/focus/redundancy and merge incidental menu clicks. Identify credentials, dates, search terms, and note-marked values as inputs; password values are secret inputs. Identify reads/copies as extract steps. Describe targets semantically, never with selectors, colours, or positions. Every step needs a verifiable expected_page. Mark cookie banners/modals optional.

You MUST return this exact shape: {"procedure_id":"string","name":"string","description":"string","starting_url":"string","inputs":[{"key":"string","label":"string","kind":"text|secret|date|number","default":"optional string"}],"steps":[{"step_id":"string","intent":"string","action":"click|type|select|navigate|extract|wait","target_description":"string","target_hints":{"role":"optional string","accessible_name":"optional string","near_text":"optional string","landmark":"optional string"},"value_source":{"kind":"input|literal","key":"optional string","literal":"optional string"},"extract":{"output_key":"string","what":"string","format":"text|number|currency|date"},"expected_page":"string","optional":false}],"outputs":[{"key":"string","label":"string","destination":"sheet|clipboard|display"}]}. target_hints is REQUIRED for every step, even when empty. value_source and extract are optional. inputs and outputs must be arrays, even when empty.`;

function context(trace: Trace): string {
  return JSON.stringify({
    trace_id: trace.trace_id,
    steps: trace.steps,
    snapshots: trace.snapshots.map((item) => ({
      url: item.url,
      timestamp: item.timestamp,
      nodes: item.nodes.filter((node) => node.role !== "generic" && node.accessible_name.trim()).slice(0, 80).map((node) => `${node.role}: ${node.accessible_name}`)
    })),
    notes: trace.notes
  });
}
async function callOpenAI(input: string, repair?: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured on the server.");
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: "gpt-5.6", input: [{ role: "system", content: prompt }, { role: "user", content: `${repair ?? ""}\n${input}` }], text: { format: { type: "json_object" } } }), signal: AbortSignal.timeout(90_000) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new Error("OpenAI compilation timed out after 90 seconds. Try a shorter trace.");
    throw error;
  }
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
function validationDetail(raw: string): string {
  try {
    const result = ProcedureSchema.safeParse(JSON.parse(raw));
    if (result.success) return "";
    return result.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
  } catch (error) { return `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`; }
}
export async function compileTrace(trace: Trace): Promise<Procedure> {
  const input = context(trace);
  let raw = await callOpenAI(input);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const detail = validationDetail(raw);
    try {
      const result = ProcedureSchema.safeParse(JSON.parse(raw));
      if (result.success) return result.data;
    } catch {
      // The repair request below handles invalid JSON as well as invalid schema fields.
    }
    console.warn("Compiler validation failure", { attempt, detail });
    raw = await callOpenAI(input, `Repair the previous invalid Procedure JSON. Return a complete JSON object only. Validation issues: ${detail}\n\nPrevious JSON:\n${raw}`);
  }
  throw new Error(`Compiler output did not validate after repair: ${validationDetail(raw)}`);
}
