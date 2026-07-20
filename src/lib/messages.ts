import type { CapturePayload, RecorderState, Trace } from "./types";
import type { Procedure } from "./procedure";

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
  | { type: "RECORDING_STARTED" }
  | { type: "RECORDING_STOPPED" };

export interface StateResponse { state: RecorderState; traces?: Trace[]; procedures?: Procedure[]; backendUrl?: string; userEmail?: string; }
