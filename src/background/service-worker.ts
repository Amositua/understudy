import type { Message } from "../lib/messages";
import type { CapturePayload, RecorderState, Trace } from "../lib/types";
import type { Procedure } from "../lib/procedure";
import type { ExecutionState, RuntimeNode } from "../lib/executor";
import * as api from "../lib/api";

const SESSION_KEY = "understudy.activeRecorder";
const TRACES_KEY = "understudy.traces";
const PROCEDURES_KEY = "understudy.procedures";
const BACKEND_URL = "understudy.backendUrl";
const SESSION = "understudy.session";
const SHEETS_WEBHOOK = "understudy.sheetsWebhookUrl";
const EXECUTION_KEY = "understudy.execution";
let state: RecorderState = { recording: false, trace: null };
let execution: ExecutionState = { running: false, steps: [], outputs: {} };
let executionContext: { procedure: Procedure; inputValues: Record<string, string> } | null = null;
let writeQueue = Promise.resolve();

void restoreState();
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

async function restoreState(): Promise<void> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const restored = stored[SESSION_KEY] as RecorderState | undefined;
  if (restored?.recording && restored.trace) state = restored;
  const storedExecution = await chrome.storage.session.get(EXECUTION_KEY);
  const restoredExecution = storedExecution[EXECUTION_KEY] as ExecutionState | undefined;
  if (restoredExecution) execution = { ...restoredExecution, running: false, error: "Execution stopped because the extension was restarted." };
}

async function publishExecution(): Promise<void> {
  await chrome.storage.session.set({ [EXECUTION_KEY]: execution });
  chrome.runtime.sendMessage({ type: "GET_STATE" }).catch(() => undefined);
}

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Open the page to run the procedure in an active tab.");
  return tab;
}

async function executorMessage<T>(tabId: number, message: Message): Promise<T> {
  try { return await chrome.tabs.sendMessage(tabId, message) as T; }
  catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/content.js"] });
    return await chrome.tabs.sendMessage(tabId, message) as T;
  }
}

function valueFor(step: Procedure["steps"][number], values: Record<string, string>): string | undefined {
  if (!step.value_source) return undefined;
  return step.value_source.kind === "input" ? values[step.value_source.key ?? ""] : step.value_source.literal;
}

function validExtraction(value: string, format: string): boolean {
  if (!value.trim()) return false;
  if (format === "number") return Number.isFinite(Number(value.replace(/[^0-9.-]/g, "")));
  if (format === "currency") return /[0-9]/.test(value) && /[$€£₦]|USD|EUR|GBP|NGN/i.test(value);
  if (format === "date") return !Number.isNaN(Date.parse(value));
  return true;
}

async function saveUpdatedProcedure(procedure: Procedure): Promise<void> {
  const procedures = ((await chrome.storage.local.get(PROCEDURES_KEY))[PROCEDURES_KEY] as Procedure[] | undefined) ?? [];
  await chrome.storage.local.set({ [PROCEDURES_KEY]: [procedure, ...procedures.filter((item) => item.procedure_id !== procedure.procedure_id)] });
  const stored = await chrome.storage.local.get([BACKEND_URL, SESSION]); const session = stored[SESSION] as api.Session | undefined;
  if (session) await api.saveProcedure((stored[BACKEND_URL] as string | undefined) ?? api.DEFAULT_API_URL, session.token, procedure);
}

async function deliverOutputs(procedure: Procedure): Promise<void> {
  const stored = await chrome.storage.local.get(SHEETS_WEBHOOK);
  const sheetOutputs = procedure.outputs.filter((output) => output.destination === "sheet").reduce<Record<string, string>>((all, output) => ({ ...all, [output.key]: execution.outputs[output.key] ?? "" }), {});
  if (Object.keys(sheetOutputs).length) {
    const webhook = stored[SHEETS_WEBHOOK] as string | undefined;
    if (!webhook) { execution.error = "A sheet output was produced, but no Sheets webhook URL is configured."; return; }
    const response = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timestamp: new Date().toISOString(), procedure_id: procedure.procedure_id, outputs: sheetOutputs }) });
    if (!response.ok) execution.error = `Could not append outputs to the Sheet endpoint (${response.status}).`;
  }
}

async function runProcedure(procedure: Procedure, inputValues: Record<string, string>, startAt = 0): Promise<void> {
  const stored = await chrome.storage.local.get([BACKEND_URL, SESSION]); const session = stored[SESSION] as api.Session | undefined;
  if (!session) throw new Error("Sign in before running a procedure.");
  const url = (stored[BACKEND_URL] as string | undefined) ?? api.DEFAULT_API_URL;
  const tab = await activeTab();
  executionContext = { procedure, inputValues };
  execution = { running: true, procedure_id: procedure.procedure_id, current_step: startAt, outputs: execution.outputs, steps: procedure.steps.map((step, index) => ({ step_id: step.step_id, intent: step.intent, status: index < startAt ? "complete" : "pending", narration: index < startAt ? "Completed" : "Waiting" })) };
  await publishExecution();
  for (let index = startAt; index < procedure.steps.length; index += 1) {
    if (!execution.running) return;
    const step = procedure.steps[index]; const live = execution.steps[index]; execution.current_step = index; live.status = "active"; live.narration = `Looking for ${step.target_description}…`; await publishExecution();
    let completed = false; let retryReason: string | undefined;
    for (let attempt = 0; attempt < 2 && !completed; attempt += 1) {
      const before = await executorMessage<{ nodes: RuntimeNode[] }>(tab.id!, { type: "EXECUTION_SNAPSHOT" });
      let grounded = await api.ground(url, session.token, step, before.nodes, retryReason);
      if (!grounded.ref_id || grounded.confidence < 0.55) {
        const screenshot = await captureScreenshot(tab.windowId);
        grounded = await api.ground(url, session.token, step, before.nodes, retryReason, screenshot ?? undefined);
      }
      live.confidence = grounded.confidence; live.reason = grounded.reason;
      if (!grounded.ref_id || grounded.confidence < 0.55) {
        if (step.optional) { live.status = "complete"; live.narration = "Optional step skipped — no confident match."; completed = true; await publishExecution(); break; }
        execution.running = false; live.status = "paused"; live.narration = "Paused — point at the right element."; execution.paused = { step_id: step.step_id, intent: step.intent, found: grounded.ref_id ?? "No plausible target", reason: grounded.reason }; await publishExecution(); return;
      }
      live.narration = `Found it — ${grounded.reason}`; await publishExecution();
      const acted = await executorMessage<{ ok: boolean; label: string; error?: string }>(tab.id!, { type: "EXECUTION_ACTION", refId: grounded.ref_id, step, value: valueFor(step, inputValues) });
      if (!acted.ok) { retryReason = acted.error ?? "The selected element could not be acted on."; live.narration = `Retrying — ${retryReason}`; await publishExecution(); continue; }
      live.narration = `${step.action === "extract" ? "Reading" : "Acted"}. Verifying…`; await publishExecution();
      if (step.action === "extract" && step.extract) {
        let result = await api.extract(url, session.token, step, before.nodes);
        if (!validExtraction(result.value, step.extract.format)) result = await api.extract(url, session.token, step, before.nodes, await captureScreenshot(tab.windowId) ?? undefined);
        if (!validExtraction(result.value, step.extract.format)) { retryReason = "The extracted value did not match the required format."; continue; }
        execution.outputs[step.extract.output_key] = result.value; live.reason = result.reason;
      }
      const after = await executorMessage<{ nodes: RuntimeNode[] }>(tab.id!, { type: "EXECUTION_SNAPSHOT" });
      const checked = await api.verify(url, session.token, step, after.nodes);
      live.reason = checked.reason;
      if (checked.achieved || step.action === "extract") { live.status = "complete"; live.narration = "Completed"; completed = true; await publishExecution(); }
      else { retryReason = checked.reason; live.narration = `Verification needs a retry — ${checked.reason}`; await publishExecution(); }
    }
    if (!completed) { execution.running = false; live.status = "failed"; live.narration = "Could not complete this step."; execution.error = `Step ${index + 1} failed after two attempts.`; await publishExecution(); return; }
  }
  execution.running = false; await deliverOutputs(procedure); await publishExecution();
}

function newTrace(): Trace {
  return { trace_id: crypto.randomUUID(), started_at: Date.now(), ended_at: 0, steps: [], snapshots: [], screenshots: [], notes: [] };
}

async function persistSession(): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: state });
}

async function captureScreenshot(windowId: number | undefined): Promise<string | null> {
  try {
    const options = { format: "jpeg" as const, quality: 60 };
    const raw = windowId === undefined
      ? await chrome.tabs.captureVisibleTab(options)
      : await chrome.tabs.captureVisibleTab(windowId, options);
    const image = await createImageBitmap(await (await fetch(raw)).blob());
    const width = Math.min(1024, image.width);
    const height = Math.round(image.height * (width / image.width));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

async function recordCapture(payload: CapturePayload, windowId?: number): Promise<void> {
  if (!state.recording || !state.trace) return;
  const trace = state.trace;
  trace.snapshots.push(...payload.snapshots);
  for (const rawStep of payload.steps) {
    const step = { ...rawStep, index: trace.steps.length };
    trace.steps.push(step);
    const screenshot = await captureScreenshot(windowId);
    if (screenshot) trace.screenshots.push({ step_index: step.index, data_url: screenshot });
  }
  await persistSession();
}

async function armActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      const armed = await chrome.tabs.sendMessage(tab.id, { type: "RECORDING_STARTED" }) as { content_recorder?: boolean } | undefined;
      console.info(armed?.content_recorder ? "Understudy recorder armed" : "Understudy recorder signalled (legacy content script)", { tabId: tab.id, url: tab.url });
    } catch (initialError) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/content.js"] });
        const armed = await chrome.tabs.sendMessage(tab.id, { type: "RECORDING_STARTED" }) as { content_recorder?: boolean } | undefined;
        console.info(armed?.content_recorder ? "Understudy recorder injected and armed" : "Understudy recorder injected", { tabId: tab.id, url: tab.url });
      } catch (injectionError) {
        console.error("Understudy could not arm the content recorder", { tabId: tab.id, url: tab.url, initialError, injectionError });
      }
    }
  }
}

async function startRecording(): Promise<RecorderState> {
  state = { recording: true, trace: newTrace() };
  await persistSession();
  void armActiveTab().catch((error: unknown) => console.error("Understudy could not query the active tab", error));
  return state;
}

async function stopRecording(): Promise<RecorderState> {
  if (state.trace) {
    state.trace.ended_at = Date.now();
    const stored = await chrome.storage.local.get(TRACES_KEY);
    const traces = (stored[TRACES_KEY] as Trace[] | undefined) ?? [];
    await chrome.storage.local.set({ [TRACES_KEY]: [state.trace, ...traces] });
  }
  state = { recording: false, trace: null };
  await chrome.storage.session.remove(SESSION_KEY);
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) if (tab.id) chrome.tabs.sendMessage(tab.id, { type: "RECORDING_STOPPED" }).catch(() => undefined);
  return state;
}

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  writeQueue = writeQueue.then(async () => {
    switch (message.type) {
      case "START_RECORDING": sendResponse({ state: await startRecording() }); break;
      case "STOP_RECORDING": sendResponse({ state: await stopRecording() }); break;
      case "GET_STATE": {
        const stored = await chrome.storage.local.get([TRACES_KEY, PROCEDURES_KEY, BACKEND_URL, SESSION, SHEETS_WEBHOOK]); const session = stored[SESSION] as api.Session | undefined;
        sendResponse({ state, traces: (stored[TRACES_KEY] as Trace[] | undefined) ?? [], procedures: (stored[PROCEDURES_KEY] as Procedure[] | undefined) ?? [], backendUrl: (stored[BACKEND_URL] as string | undefined) ?? api.DEFAULT_API_URL, userEmail: session?.user.email, execution, sheetsWebhookUrl: (stored[SHEETS_WEBHOOK] as string | undefined) ?? "" });
        break;
      }
      case "RECORDER_STATUS": sendResponse({ state }); break;
      case "CAPTURE": await recordCapture(message.payload, sender.tab?.windowId); sendResponse({ state }); break;
      case "ADD_NOTE": {
        if (state.trace && state.trace.steps.length && message.text.trim()) {
          state.trace.notes.push({ step_index: state.trace.steps.length - 1, text: message.text.trim() });
          await persistSession();
        }
        sendResponse({ state });
        break;
      }
      case "SAVE_BACKEND_CONFIG":
        await chrome.storage.local.set({ [BACKEND_URL]: message.backendUrl.trim() });
        sendResponse({ ok: true });
        break;
      case "SAVE_EXECUTOR_SETTINGS":
        await chrome.storage.local.set({ [SHEETS_WEBHOOK]: message.sheetsWebhookUrl.trim() }); sendResponse({ ok: true }); break;
      case "AUTH_REGISTER":
      case "AUTH_LOGIN": {
        const stored = await chrome.storage.local.get(BACKEND_URL); const url = (stored[BACKEND_URL] as string | undefined) ?? api.DEFAULT_API_URL;
        const session = message.type === "AUTH_REGISTER" ? await api.register(url, message.email, message.password) : await api.login(url, message.email, message.password); await chrome.storage.local.set({ [SESSION]: session }); sendResponse({ user: session.user });
        break;
      }
      case "LOGOUT": await chrome.storage.local.remove(SESSION); sendResponse({ ok: true }); break;
      case "COMPILE_TRACE": {
        const stored = await chrome.storage.local.get([BACKEND_URL, SESSION]); const url = (stored[BACKEND_URL] as string | undefined) ?? api.DEFAULT_API_URL; const session = stored[SESSION] as api.Session | undefined; if (!session) throw new Error("Sign in before compiling.");
        const { procedure } = await api.compile(url, session.token, message.trace);
        const procedures = ((await chrome.storage.local.get(PROCEDURES_KEY))[PROCEDURES_KEY] as Procedure[] | undefined) ?? [];
        await chrome.storage.local.set({ [PROCEDURES_KEY]: [procedure, ...procedures.filter((item) => item.procedure_id !== procedure.procedure_id)] });
        sendResponse({ procedure });
        break;
      }
      case "SAVE_PROCEDURE": {
        const procedures = ((await chrome.storage.local.get(PROCEDURES_KEY))[PROCEDURES_KEY] as Procedure[] | undefined) ?? [];
        const stored = await chrome.storage.local.get([BACKEND_URL, SESSION]); const url = (stored[BACKEND_URL] as string | undefined) ?? api.DEFAULT_API_URL; const session = stored[SESSION] as api.Session | undefined; if (!session) throw new Error("Sign in before saving procedures."); await api.saveProcedure(url, session.token, message.procedure); await chrome.storage.local.set({ [PROCEDURES_KEY]: [message.procedure, ...procedures.filter((item) => item.procedure_id !== message.procedure.procedure_id)] });
        sendResponse({ procedure: message.procedure });
        break;
      }
      case "RUN_PROCEDURE":
        sendResponse({ started: true }); void runProcedure(message.procedure, message.inputValues).catch(async (error: unknown) => { execution.running = false; execution.error = error instanceof Error ? error.message : String(error); await publishExecution(); });
        break;
      case "STOP_EXECUTION": execution.running = false; execution.error = "Execution stopped."; await publishExecution(); sendResponse({ ok: true }); break;
      case "EXECUTION_ENABLE_POINTER": {
        const tab = await activeTab(); await executorMessage(tab.id!, message); sendResponse({ ok: true }); break;
      }
      case "EXECUTION_POINTER_TARGET": {
        if (!execution.paused || execution.paused.step_id !== message.stepId || !executionContext) { sendResponse({ ok: false }); break; }
        const stepIndex = executionContext.procedure.steps.findIndex((step) => step.step_id === message.stepId);
        if (stepIndex < 0) { sendResponse({ ok: false }); break; }
        executionContext.procedure.steps[stepIndex] = { ...executionContext.procedure.steps[stepIndex], target_hints: { ...executionContext.procedure.steps[stepIndex].target_hints, role: message.role, accessible_name: message.accessibleName } };
        await saveUpdatedProcedure(executionContext.procedure); execution.paused = undefined; sendResponse({ ok: true }); void runProcedure(executionContext.procedure, executionContext.inputValues, stepIndex).catch(async (error: unknown) => { execution.running = false; execution.error = String(error); await publishExecution(); }); break;
      }
      case "RECORDING_STARTED":
      case "RECORDING_STOPPED":
      case "EXECUTION_SNAPSHOT":
      case "EXECUTION_ACTION":
        sendResponse({ state });
        break;
      default: {
        const exhaustive: never = message;
        throw new Error(`Unknown message: ${String(exhaustive)}`);
      }
    }
  }).catch((error: unknown) => sendResponse({ error: String(error) }));
  return true;
});
