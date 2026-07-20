export type StepType = "click" | "input" | "change" | "navigate" | "scroll";

export interface TargetDescriptor {
  role: string;
  accessible_name: string;
  tag: string;
  text: string;
  attributes: { id?: string; name?: string; type?: string; placeholder?: string; aria_label?: string; href?: string; value?: string };
  selector_candidates: string[];
  bounding_box: { x: number; y: number; w: number; h: number };
}

export interface Step {
  index: number;
  type: StepType;
  timestamp: number;
  url: string;
  page_title: string;
  target: TargetDescriptor;
  value?: string;
  page_context: { heading_hierarchy: string[]; landmark: string };
}

export interface A11yNode { role: string; accessible_name: string; reference_id: string; }
export interface A11ySnapshot { url: string; timestamp: number; nodes: A11yNode[]; }
export interface TraceScreenshot { step_index: number; data_url: string; }
export interface TraceNote { step_index: number; text: string; }
export interface Trace {
  trace_id: string;
  started_at: number;
  ended_at: number;
  steps: Step[];
  snapshots: A11ySnapshot[];
  screenshots: TraceScreenshot[];
  notes: TraceNote[];
}

export type UnindexedStep = Omit<Step, "index">;
export interface CapturePayload { steps: UnindexedStep[]; snapshots: A11ySnapshot[]; }
export interface RecorderState { recording: boolean; trace: Trace | null; }
