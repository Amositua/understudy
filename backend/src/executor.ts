import { z } from "zod";

type Node = { role: string; accessible_name: string; reference_id: string; nearby_text?: string };
type Step = { intent: string; action: string; target_description: string; target_hints: Record<string, string | undefined>; expected_page: string; extract?: { what: string; format: string } };

const groundSchema = z.object({ ref_id: z.string().nullable(), confidence: z.number().min(0).max(1), reason: z.string().min(1).max(500) });
const verifySchema = z.object({ achieved: z.boolean(), reason: z.string().min(1).max(500) });
const extractSchema = z.object({ value: z.string().min(1), reason: z.string().min(1).max(500) });
const groundPrompt = "You are Understudy's Grounder. Given an intent, semantic target description, hints, and accessibility candidates, select the candidate that best fulfils the intent. Labels may have changed (for example Download CSV instead of Export) and position is irrelevant. Return null instead of guessing. Strict JSON only: {ref_id:string|null,confidence:number,reason:string}.";

async function ai(system: string, payload: unknown): Promise<unknown> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured on the server.");
  const withScreenshot = payload as { screenshot?: string };
  const { screenshot, ...textPayload } = withScreenshot;
  const userContent = screenshot
    ? [{ type: "input_text", text: JSON.stringify(textPayload) }, { type: "input_image", image_url: screenshot }]
    : JSON.stringify(textPayload);
  const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: "gpt-5.6", input: [{ role: "system", content: system }, { role: "user", content: userContent }], text: { format: { type: "json_object" } } }), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`OpenAI executor request failed (${response.status}): ${await response.text()}`);
  const body = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  const text = body.output_text ?? body.output?.flatMap((item) => item.content ?? []).filter((item) => item.type === "output_text").map((item) => item.text ?? "").join("");
  if (!text) throw new Error("OpenAI returned no executor output.");
  return JSON.parse(text);
}

export async function ground(step: Step, nodes: Node[], retryReason?: string, screenshot?: string): Promise<z.infer<typeof groundSchema>> {
  return groundSchema.parse(await ai(groundPrompt, { step, candidates: nodes.slice(0, 300), retry_reason: retryReason, screenshot }));
}
export async function verify(step: Step, nodes: Node[]): Promise<z.infer<typeof verifySchema>> {
  return verifySchema.parse(await ai("You verify browser procedure steps. Decide whether expected_page is now true from the accessibility tree. Strict JSON only: {achieved:boolean,reason:string}.", { expected_page: step.expected_page, intent: step.intent, nodes: nodes.slice(0, 300) }));
}
export async function extract(step: Step, nodes: Node[], screenshot?: string): Promise<z.infer<typeof extractSchema>> {
  return extractSchema.parse(await ai("Extract the requested value from accessibility text. Apply the requested format. Numbers must parse, currency must include magnitude, and dates must be resolvable. Strict JSON only: {value:string,reason:string}.", { extraction: step.extract, target: step.target_description, nodes: nodes.slice(0, 300), screenshot }));
}
