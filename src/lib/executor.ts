import { z } from "zod";

export const GroundingSchema = z.object({
  ref_id: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(500)
});
export type Grounding = z.infer<typeof GroundingSchema>;

export const VerificationSchema = z.object({ achieved: z.boolean(), reason: z.string().min(1).max(500) });
export type Verification = z.infer<typeof VerificationSchema>;

export const ExtractionSchema = z.object({ value: z.string().min(1), reason: z.string().min(1).max(500) });
export type Extraction = z.infer<typeof ExtractionSchema>;

export type ExecutionStepState = {
  step_id: string;
  intent: string;
  status: "pending" | "active" | "complete" | "paused" | "failed";
  narration: string;
  reason?: string;
  confidence?: number;
};

export type ExecutionState = {
  running: boolean;
  procedure_id?: string;
  current_step?: number;
  steps: ExecutionStepState[];
  outputs: Record<string, string>;
  error?: string;
  paused?: { step_id: string; intent: string; found: string; reason: string; picking?: boolean };
};

export type RuntimeNode = { role: string; accessible_name: string; reference_id: string; nearby_text?: string };
