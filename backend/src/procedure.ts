import { z } from "zod";
export const ProcedureSchema = z.object({
  procedure_id: z.string().min(1), name: z.string().min(1), description: z.string().min(1), starting_url: z.string().min(1),
  inputs: z.array(z.object({ key: z.string().min(1), label: z.string().min(1), kind: z.enum(["text", "secret", "date", "number"]), default: z.string().optional() })),
  steps: z.array(z.object({ step_id: z.string().min(1), intent: z.string().min(1), action: z.enum(["click", "type", "select", "navigate", "extract", "wait"]), target_description: z.string().min(1), target_hints: z.object({ role: z.string().optional(), accessible_name: z.string().optional(), near_text: z.string().optional(), landmark: z.string().optional() }), value_source: z.object({ kind: z.enum(["input", "literal"]), key: z.string().optional(), literal: z.string().optional() }).optional(), extract: z.object({ output_key: z.string().min(1), what: z.string().min(1), format: z.enum(["text", "number", "currency", "date"]) }).optional(), expected_page: z.string().min(1), optional: z.boolean() })),
  outputs: z.array(z.object({ key: z.string().min(1), label: z.string().min(1), destination: z.enum(["sheet", "clipboard", "display"]) }))
});
export type Procedure = z.infer<typeof ProcedureSchema>;
