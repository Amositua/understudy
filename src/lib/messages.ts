import type { CapturePayload, RecorderState, Trace } from "./types";
import type { Procedure } from "./procedure";
import type { ExecutionState } from "./executor";

export type Message =
  | { type: "START_RECORDING" }
  | { type: "STOP_RECORDING" }
  | { type: "GET_STATE" }
  | { type: "RECORDER_STATUS" }
  | { type: "CAPTURE"; payload: CapturePayload }
  | { type: "ADD_NOTE"; text: string }
  | { type: "SAVE_BACKEND_CONFIG"; backendUrl: string }
  | { type: "AUTH_REGISTER"; email: string; password: string }
  | { type: "AUTH_LOGIN"; email: string; password: string }
  | { type: "LOGOUT" }
  | { type: "COMPILE_TRACE"; trace: Trace }
  | { type: "SAVE_PROCEDURE"; procedure: Procedure }
  | { type: "RUN_PROCEDURE"; procedure: Procedure; inputValues: Record<string, string> }
  | { type: "STOP_EXECUTION" }
  | { type: "EXECUTION_SNAPSHOT" }
  | { type: "EXECUTION_ACTION"; refId: string; step: Procedure["steps"][number]; value?: string }
  | { type: "EXECUTION_ENABLE_POINTER"; stepId: string }
  | { type: "EXECUTION_POINTER_TARGET"; stepId: string; role: string; accessibleName: string }
  | { type: "SAVE_EXECUTOR_SETTINGS"; sheetsWebhookUrl: string }
  | { type: "RECORDING_STARTED" }
  | { type: "RECORDING_STOPPED" };

export interface StateResponse { state: RecorderState; traces?: Trace[]; procedures?: Procedure[]; backendUrl?: string; userEmail?: string; execution?: ExecutionState; sheetsWebhookUrl?: string; }
