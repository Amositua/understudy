import { useCallback, useEffect, useMemo, useState } from "react";
import type { Message, StateResponse } from "../lib/messages";
import type { Step, Trace } from "../lib/types";
import { ProcedureSchema, type Procedure, type ProcedureInput, type ProcedureStep } from "../lib/procedure";

const actions = ["click", "type", "select", "navigate", "extract", "wait"] as const;
const addableActions = ["click", "type", "extract"] as const;

function description(step: Step): string {
  if (step.type === "navigate") return `Navigated to '${step.page_title || step.url}' (${step.url})`;
  const name = step.target.accessible_name || step.target.text || step.target.tag;
  const verbs: Record<Exclude<Step["type"], "navigate">, string> = { click: "Clicked", input: "Typed into", change: "Changed", scroll: "Scrolled to" };
  return `${verbs[step.type]} '${name}'`;
}

function StepList({ steps }: { steps: Step[] }) {
  return <ol className="space-y-2">{steps.map((step) => <li key={step.index} className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm"><span className="mr-2 text-xs text-slate-500">{step.index + 1}</span>{description(step)}</li>)}</ol>;
}

function newStep(action: typeof addableActions[number]): ProcedureStep {
  const stepId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `step-${Date.now()}`;
  return {
    step_id: stepId,
    intent: action === "extract" ? "Extract the required value" : action === "type" ? "Enter the required value" : "Activate the required control",
    action,
    target_description: action === "extract" ? "The value to read from the page" : "The relevant page control",
    target_hints: {},
    value_source: action === "type" ? { kind: "literal", literal: "" } : undefined,
    extract: action === "extract" ? { output_key: "extracted_value", what: "the required value", format: "text" } : undefined,
    expected_page: action === "extract" ? "The value is available to use." : "The requested action has completed.",
    optional: false
  };
}

function Review({ procedure, rawCount, onSave, onBack }: { procedure: Procedure; rawCount: number; onSave: (p: Procedure) => void; onBack: () => void }) {
  const [draft, setDraft] = useState(procedure);
  const update = (patch: Partial<Procedure>) => setDraft((value) => ({ ...value, ...patch }));
  const updateStep = (index: number, patch: Partial<ProcedureStep>) => update({ steps: draft.steps.map((step, i) => i === index ? { ...step, ...patch } : step) });
  const deleteStep = (index: number) => update({ steps: draft.steps.filter((_, i) => i !== index) });
  const insertStep = (index: number, action: typeof addableActions[number]) => update({ steps: [...draft.steps.slice(0, index), newStep(action), ...draft.steps.slice(index)] });
  const moveStep = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[index], steps[destination]] = [steps[destination], steps[index]];
    update({ steps });
  };
  const changeAction = (index: number, action: ProcedureStep["action"]) => updateStep(index, {
    action,
    value_source: action === "type" ? draft.steps[index].value_source ?? { kind: "literal", literal: "" } : undefined,
    extract: action === "extract" ? draft.steps[index].extract ?? { output_key: "extracted_value", what: "the required value", format: "text" } : undefined
  });

  return <section className="space-y-4">
    <button onClick={onBack} className="text-sm text-indigo-300">← Back</button>
    <input value={draft.name} onChange={(e) => update({ name: e.target.value })} className="w-full bg-transparent text-lg font-semibold outline-none" aria-label="Procedure name" />
    <textarea value={draft.description} onChange={(e) => update({ description: e.target.value })} className="w-full resize-none rounded border border-slate-700 bg-slate-900 p-2 text-sm" aria-label="Procedure description" />
    <p className="rounded bg-indigo-500/10 p-2 text-sm text-indigo-200">The raw recording had {rawCount} actions; this procedure has {draft.steps.length} steps.</p>

    <h2 className="font-medium">Inputs</h2>
    {draft.inputs.map((input, index) => <div key={`${input.key}-${index}`} className="flex gap-2">
      <input value={input.label} onChange={(e) => update({ inputs: draft.inputs.map((item, i) => i === index ? { ...item, label: e.target.value } : item) })} className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 p-2 text-sm" />
      <select value={input.kind} onChange={(e) => update({ inputs: draft.inputs.map((item, i) => i === index ? { ...item, kind: e.target.value as ProcedureInput["kind"] } : item) })} className="rounded bg-slate-800 text-xs">{["text", "secret", "date", "number"].map((kind) => <option key={kind}>{kind}</option>)}</select>
      <button onClick={() => update({ inputs: draft.inputs.filter((_, i) => i !== index) })} aria-label={`Remove ${input.label}`}>×</button>
    </div>)}
    <button onClick={() => update({ inputs: [...draft.inputs, { key: `input_${draft.inputs.length + 1}`, label: "New input", kind: "text" }] })} className="text-sm text-indigo-300">+ Add input</button>

    <h2 className="font-medium">Procedure</h2>
    <ol className="space-y-3">
      {draft.steps.map((step, index) => <li key={step.step_id} className="space-y-3">
        <article className={`rounded-lg border p-3 ${step.action === "extract" ? "border-amber-400/60 bg-amber-400/10" : step.optional ? "border-slate-800 bg-slate-900/50 opacity-70" : "border-slate-700 bg-slate-900"}`}>
          <div className="mb-2 flex gap-2">
            <span className="text-xs text-slate-500">{index + 1}</span>
            <select value={step.action} onChange={(e) => changeAction(index, e.target.value as ProcedureStep["action"])} className="rounded bg-slate-800 px-2 text-xs" aria-label={`Action for step ${index + 1}`}>{actions.map((action) => <option key={action}>{action}</option>)}</select>
            <button onClick={() => moveStep(index, -1)} disabled={index === 0} className="text-xs disabled:opacity-30" aria-label="Move step up">↑</button>
            <button onClick={() => moveStep(index, 1)} disabled={index === draft.steps.length - 1} className="text-xs disabled:opacity-30" aria-label="Move step down">↓</button>
            <label className="ml-auto text-xs"><input checked={step.optional} type="checkbox" onChange={(e) => updateStep(index, { optional: e.target.checked })} /> optional</label>
            <button onClick={() => deleteStep(index)} aria-label={`Delete step ${index + 1}`}>×</button>
          </div>
          <input value={step.intent} onChange={(e) => updateStep(index, { intent: e.target.value })} className="w-full bg-transparent text-base font-medium outline-none" aria-label="Step intent" />
          <input value={step.target_description} onChange={(e) => updateStep(index, { target_description: e.target.value })} className="mt-1 w-full bg-transparent text-sm text-slate-400 outline-none" aria-label="Target description" />
          {step.action === "type" && <div className="mt-2 grid grid-cols-3 gap-2">
            <select value={step.value_source?.kind ?? "literal"} onChange={(e) => updateStep(index, { value_source: { kind: e.target.value as "input" | "literal", ...(e.target.value === "input" ? { key: "" } : { literal: "" }) } })} className="rounded bg-slate-800 p-2 text-xs" aria-label="Value source"><option value="literal">literal</option><option value="input">input</option></select>
            <input value={step.value_source?.kind === "input" ? step.value_source.key ?? "" : step.value_source?.literal ?? ""} onChange={(e) => updateStep(index, { value_source: step.value_source?.kind === "input" ? { kind: "input", key: e.target.value } : { kind: "literal", literal: e.target.value } })} className="col-span-2 rounded bg-slate-950 p-2 text-xs" placeholder={step.value_source?.kind === "input" ? "Input key" : "Value to type"} />
          </div>}
          {step.action === "extract" && step.extract && <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <input value={step.extract.output_key} onChange={(e) => updateStep(index, { extract: { ...step.extract!, output_key: e.target.value } })} className="rounded bg-slate-950 p-2" placeholder="Output key" />
            <select value={step.extract.format} onChange={(e) => updateStep(index, { extract: { ...step.extract!, format: e.target.value as ProcedureStep["extract"] extends infer T ? T extends { format: infer F } ? F : never : never } })} className="rounded bg-slate-800 p-2"><option value="text">text</option><option value="number">number</option><option value="currency">currency</option><option value="date">date</option></select>
            <input value={step.extract.what} onChange={(e) => updateStep(index, { extract: { ...step.extract!, what: e.target.value } })} className="col-span-2 rounded bg-slate-950 p-2" placeholder="What to extract" />
          </div>}
          <input value={step.expected_page} onChange={(e) => updateStep(index, { expected_page: e.target.value })} className="mt-2 w-full rounded bg-slate-950 p-2 text-xs text-slate-400 outline-none" aria-label="Expected page result" />
        </article>
        <details className="rounded border border-dashed border-slate-700 px-3 py-2 text-sm">
          <summary className="cursor-pointer text-indigo-300">+ Add step here</summary>
          <div className="mt-2 flex gap-2"><span className="text-xs text-slate-400">Action:</span>{addableActions.map((action) => <button key={action} onClick={() => insertStep(index + 1, action)} className="rounded bg-slate-800 px-2 py-1 text-xs">{action}</button>)}</div>
        </details>
      </li>)}
      {draft.steps.length === 0 && <li><details className="rounded border border-dashed border-slate-700 px-3 py-2 text-sm" open><summary className="cursor-pointer text-indigo-300">+ Add step</summary><div className="mt-2 flex gap-2"><span className="text-xs text-slate-400">Action:</span>{addableActions.map((action) => <button key={action} onClick={() => insertStep(0, action)} className="rounded bg-slate-800 px-2 py-1 text-xs">{action}</button>)}</div></details></li>}
    </ol>
    <button onClick={() => { const result = ProcedureSchema.safeParse(draft); if (result.success) onSave(result.data); }} className="w-full rounded-lg bg-indigo-500 p-3 font-semibold">Save procedure</button>
  </section>;
}

export function App() {
  const [recording, setRecording] = useState(false);
  const [activeTrace, setActiveTrace] = useState<Trace | null>(null);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState<Trace | null>(null);
  const [review, setReview] = useState<{ procedure: Procedure; rawCount: number } | null>(null);
  const [settings, setSettings] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [userEmail, setUserEmail] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => { try { const r = await chrome.runtime.sendMessage({ type: "GET_STATE" } satisfies Message) as StateResponse; setRecording(r.state.recording); setActiveTrace(r.state.trace); setTraces(r.traces ?? []); setProcedures(r.procedures ?? []); setUserEmail(r.userEmail); } catch (reason) { setError(`Could not reach Understudy's background worker: ${reason instanceof Error ? reason.message : String(reason)}`); } }, []);
  useEffect(() => { void refresh(); const listener = (m: Message) => { if (m.type === "GET_STATE") void refresh(); }; chrome.runtime.onMessage.addListener(listener); return () => chrome.runtime.onMessage.removeListener(listener); }, [refresh]);
  useEffect(() => { if (!recording) return; const timer = window.setInterval(() => void refresh(), 500); return () => window.clearInterval(timer); }, [recording, refresh]);
  const send = async (message: Message): Promise<unknown> => { const response = await chrome.runtime.sendMessage(message) as { error?: unknown }; if (typeof response?.error === "string") throw new Error(response.error); return response; };
  const report = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const compile = async (trace: Trace) => { setBusy(true); setError(""); try { const response = await send({ type: "COMPILE_TRACE", trace } as Message) as { procedure?: Procedure }; if (!response.procedure) throw new Error("The compiler returned no procedure."); setReview({ procedure: response.procedure, rawCount: trace.steps.length }); await refresh(); } catch (e) { report(e); } finally { setBusy(false); } };
  const detail = selected ?? (recording ? activeTrace : null);
  const screenshotMap = useMemo(() => new Map(detail?.screenshots.map((item) => [item.step_index, item.data_url])), [detail]);
  if (review) return <main className="min-h-screen p-4"><Review procedure={review.procedure} rawCount={review.rawCount} onBack={() => setReview(null)} onSave={async (procedure) => { try { await send({ type: "SAVE_PROCEDURE", procedure }); setReview(null); await refresh(); } catch (e) { report(e); } }} /></main>;
  if (settings) return <main className="min-h-screen space-y-3 p-4"><button onClick={() => setSettings(false)} className="text-sm text-indigo-300">← Back</button><h1 className="text-lg font-semibold">Your Understudy account</h1><p className="text-xs text-slate-400">Create an account or sign in to compile procedures. Your OpenAI key stays on the Understudy server.</p>{error && <p className="rounded bg-red-500/10 p-2 text-sm text-red-200">{error}</p>}{userEmail ? <><p className="text-sm text-emerald-300">Signed in as {userEmail}</p><button onClick={() => void send({ type: "LOGOUT" }).then(refresh).catch(report)} className="w-full rounded bg-slate-700 p-2">Sign out</button></> : <><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="w-full rounded border border-slate-700 bg-slate-900 p-3 text-sm" /><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (12+ characters)" className="w-full rounded border border-slate-700 bg-slate-900 p-3 text-sm" /><div className="flex gap-2"><button onClick={() => void send({ type: "AUTH_REGISTER", email, password }).then(refresh).catch(report)} className="flex-1 rounded bg-indigo-500 p-2">Create account</button><button onClick={() => void send({ type: "AUTH_LOGIN", email, password }).then(refresh).catch(report)} className="flex-1 rounded bg-slate-700 p-2">Sign in</button></div></>}</main>;
  return <main className="min-h-screen p-4"><header className="mb-6 flex items-center justify-between"><div><h1 className="text-lg font-semibold">Understudy</h1><p className="text-xs text-slate-400">Record, then compile intent.</p></div><button onClick={() => setSettings(true)} className="text-slate-400">⚙</button></header>{error && <p className="mb-3 rounded bg-red-500/10 p-2 text-sm text-red-200">{error}</p>}{recording ? <section className="space-y-4"><div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm">● Recording {activeTrace?.steps.length ?? 0} steps</div><StepList steps={activeTrace?.steps ?? []} /><div className="flex gap-2"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note about the last step" className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-3" /><button onClick={() => { void send({ type: "ADD_NOTE", text: note }); setNote(""); }}>Note</button></div><button onClick={() => void send({ type: "STOP_RECORDING" }).then(refresh)} className="w-full rounded bg-slate-100 p-3 font-semibold text-slate-950">Done</button></section> : detail ? <section className="space-y-3"><button onClick={() => setSelected(null)} className="text-sm text-indigo-300">← All traces</button><StepList steps={detail.steps} /><button disabled={busy} onClick={() => void compile(detail)} className="w-full rounded bg-indigo-500 p-3 font-semibold disabled:opacity-50">{busy ? "Compiling intent…" : "Compile into procedure"}</button>{detail.steps.map((step) => screenshotMap.get(step.index) && <img key={step.index} src={screenshotMap.get(step.index)} className="w-full rounded border border-slate-800" />)}</section> : <section className="space-y-5"><button onClick={() => void send({ type: "START_RECORDING" }).then(refresh)} className="w-full rounded bg-indigo-500 p-3 font-semibold">Teach me</button><div><h2 className="mb-2 text-sm font-medium">Recorded traces</h2>{traces.map((trace) => <button key={trace.trace_id} onClick={() => setSelected(trace)} className="mb-2 w-full rounded border border-slate-800 bg-slate-900 p-3 text-left text-sm">{trace.steps.length} actions <span className="text-slate-500">· {new Date(trace.started_at).toLocaleString()}</span></button>)}</div><div><h2 className="mb-2 text-sm font-medium">Procedures</h2>{procedures.map((procedure) => <button key={procedure.procedure_id} onClick={() => setReview({ procedure, rawCount: procedure.steps.length })} className="mb-2 w-full rounded border border-indigo-500/30 bg-indigo-500/10 p-3 text-left text-sm">{procedure.name}<span className="block text-xs text-slate-400">{procedure.steps.length} durable steps</span></button>)}</div></section>}</main>;
}
