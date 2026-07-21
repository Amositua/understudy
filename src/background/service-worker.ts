import type { Message } from "../lib/messages";
import type { CapturePayload, RecorderState, Trace } from "../lib/types";
import type { Procedure } from "../lib/procedure";
import * as api from "../lib/api";

const SESSION_KEY = "understudy.activeRecorder";
const TRACES_KEY = "understudy.traces";
const PROCEDURES_KEY = "understudy.procedures";
const BACKEND_URL = "understudy.backendUrl";
const SESSION = "understudy.session";
let state: RecorderState = { recording: false, trace: null };
let writeQueue = Promise.resolve();

void restoreState();
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

async function restoreState(): Promise<void> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const restored = stored[SESSION_KEY] as RecorderState | undefined;
  if (restored?.recording && restored.trace) state = restored;
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
        const stored = await chrome.storage.local.get([TRACES_KEY, PROCEDURES_KEY, BACKEND_URL, SESSION]); const session = stored[SESSION] as api.Session | undefined;
        sendResponse({ state, traces: (stored[TRACES_KEY] as Trace[] | undefined) ?? [], procedures: (stored[PROCEDURES_KEY] as Procedure[] | undefined) ?? [], backendUrl: (stored[BACKEND_URL] as string | undefined) ?? api.DEFAULT_API_URL, userEmail: session?.user.email });
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
      case "RECORDING_STARTED":
      case "RECORDING_STOPPED":
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
