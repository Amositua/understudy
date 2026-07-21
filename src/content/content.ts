import type { Message, StateResponse } from "../lib/messages";
import type { A11yNode, A11ySnapshot, CapturePayload, TargetDescriptor, UnindexedStep } from "../lib/types";
import { accessibleName, interactionTarget } from "./a11y";

let recording = false;
let inputTimer: number | undefined;
let pendingScroll: { x: number; y: number; timestamp: number } | null = null;
let lastUrl = location.href;
let navigationTimer: number | undefined;

const interactiveRoles = new Set(["button", "checkbox", "combobox", "link", "menuitem", "option", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox"]);
const landmarkRoles = new Set(["banner", "complementary", "contentinfo", "form", "main", "navigation", "region", "search"]);

/** A page can retain an old content script briefly after the extension reloads. */
function safeRuntimeMessage<T>(message: Message): Promise<T | undefined> {
  try {
    if (!chrome.runtime?.id) return Promise.resolve(undefined);
    return chrome.runtime.sendMessage(message).catch(() => undefined) as Promise<T | undefined>;
  } catch {
    return Promise.resolve(undefined);
  }
}

function textOf(element: Element): string {
  return (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
    ? ""
    : (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function implicitRole(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "a" && element.getAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (["checkbox", "radio", "range"].includes(type)) return type === "range" ? "slider" : type;
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "search") return "searchbox";
    return "textbox";
  }
  if (["main", "nav", "header", "footer", "aside", "form", "search"].includes(tag)) {
    return ({ main: "main", nav: "navigation", header: "banner", footer: "contentinfo", aside: "complementary", form: "form", search: "search" } as Record<string, string>)[tag];
  }
  return "generic";
}

function roleOf(element: Element): string { return element.getAttribute("role") || implicitRole(element); }

function cssPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && parts.length < 6) {
    const tag = current.tagName.toLowerCase();
    const siblings = Array.from(current.parentElement?.children ?? []).filter((node) => node.tagName === current?.tagName);
    parts.unshift(`${tag}:nth-of-type(${Math.max(1, siblings.indexOf(current) + 1)})`);
    current = current.parentElement;
  }
  return `body > ${parts.join(" > ")}`;
}

function candidates(element: Element, role: string, name: string): string[] {
  const values: string[] = [];
  const testId = element.getAttribute("data-testid");
  if (testId) values.push(`[data-testid="${CSS.escape(testId)}"]`);
  if (element.id) values.push(`#${CSS.escape(element.id)}`);
  if (element.getAttribute("name")) values.push(`[name="${CSS.escape(element.getAttribute("name")!)}"]`);
  if (role !== "generic" && name) values.push(`[role="${CSS.escape(role)}"][aria-label="${CSS.escape(name)}"]`);
  const text = textOf(element);
  if (text) values.push(`text=${JSON.stringify(text.slice(0, 80))}`);
  values.push(element.tagName.toLowerCase());
  values.push(cssPath(element));
  // Retain unique candidates and guarantee three useful fallbacks.
  const unique = [...new Set(values)];
  while (unique.length < 3) unique.push(`role=${role}`, `tag=${element.tagName.toLowerCase()}`);
  return [...new Set(unique)].slice(0, 6);
}

function targetFor(element: Element): TargetDescriptor {
  const rect = element.getBoundingClientRect();
  const role = roleOf(element);
  const name = accessibleName(element);
  const attributeNames = ["id", "name", "type", "placeholder", "aria-label", "href", "value"] as const;
  const attributes: TargetDescriptor["attributes"] = {};
  for (const attribute of attributeNames) {
    const value = element.getAttribute(attribute);
    if (value !== null) {
      if (attribute === "aria-label") attributes.aria_label = value;
      else attributes[attribute] = value;
    }
  }
  return { role, accessible_name: name, tag: element.tagName.toLowerCase(), text: textOf(element), attributes, selector_candidates: candidates(element, role, name), bounding_box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } };
}

function landmarkFor(element: Element): string {
  let current: Element | null = element;
  while (current) {
    const role = roleOf(current);
    if (landmarkRoles.has(role)) return role;
    current = current.parentElement;
  }
  return "document";
}

function referenceId(element: Element): string {
  if (element.id) return `id:${element.id}`;
  return `${roleOf(element)}:${accessibleName(element).slice(0, 80)}:${cssPath(element)}`;
}

function snapshot(target?: Element): A11ySnapshot {
  const all = Array.from(document.querySelectorAll("body *"));
  const nodes = all.filter((element) => {
    const role = roleOf(element);
    return interactiveRoles.has(role) || role === "heading" || landmarkRoles.has(role) || Boolean(textOf(element));
  });
  let selected = nodes;
  if (nodes.length > 300) {
    const keep = new Set<Element>(nodes.filter((element) => landmarkRoles.has(roleOf(element))));
    for (const element of nodes) {
      if (target && (element === target || target.contains(element) || element.contains(target))) keep.add(element);
    }
    if (target) selected = nodes.filter((element) => keep.has(element));
    else {
      // During execution there is no known target yet. Keep visible, named
      // controls first so large apps such as Gmail still expose Compose.
      const visible = (element: Element): number => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight ? 1 : 0;
      };
      selected = [...nodes].sort((left, right) => {
        const score = (element: Element): number => (interactiveRoles.has(roleOf(element)) ? 8 : 0) + (accessibleName(element) ? 3 : 0) + visible(element) * 4 + (landmarkRoles.has(roleOf(element)) ? 1 : 0);
        return score(right) - score(left);
      }).slice(0, 300);
    }
  }
  const a11yNodes: A11yNode[] = selected.slice(0, 300).map((element) => ({ role: roleOf(element), accessible_name: accessibleName(element), reference_id: referenceId(element) }));
  return { url: location.href, timestamp: Date.now(), nodes: a11yNodes };
}

function runtimeNodes(): Array<A11yNode & { nearby_text: string }> {
  const page = snapshot();
  return page.nodes.map((node) => ({ ...node, nearby_text: node.accessible_name }));
}

function elementForReference(refId: string): Element | null {
  return Array.from(document.querySelectorAll("body *")).find((element) => referenceId(element) === refId) ?? null;
}

function pause(milliseconds: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    const deadline = window.setTimeout(done, 8_000);
    let quiet = window.setTimeout(done, 500);
    const observer = new MutationObserver(() => { window.clearTimeout(quiet); quiet = window.setTimeout(done, 500); });
    function done(): void { window.clearTimeout(deadline); window.clearTimeout(quiet); observer.disconnect(); resolve(); }
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  });
}

async function outline(element: Element, caption: string): Promise<void> {
  const rect = element.getBoundingClientRect();
  const marker = document.createElement("div");
  marker.setAttribute("data-understudy-overlay", "true");
  marker.textContent = caption;
  Object.assign(marker.style, { position: "fixed", zIndex: "2147483647", left: `${Math.max(0, rect.left)}px`, top: `${Math.max(0, rect.top - 28)}px`, maxWidth: "320px", padding: "4px 7px", border: "2px solid #818cf8", borderRadius: "5px", background: "#312e81", color: "white", font: "12px system-ui", pointerEvents: "none", boxShadow: "0 0 0 3px rgba(129,140,248,.35)" });
  document.documentElement.append(marker);
  await pause(400);
  marker.remove();
}

function dismissCookieBanner(): void {
  const button = Array.from(document.querySelectorAll("button, [role=button]")).find((element) => /^(dismiss|close|accept)( cookies?| cookie notice)?$/i.test(accessibleName(element)) || /cookie/i.test(element.closest("aside, [role=dialog], div")?.textContent ?? "") && /dismiss|close|accept/i.test(accessibleName(element)));
  if (button) (button as HTMLElement).click();
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function executeAction(refId: string, step: import("../lib/procedure").ProcedureStep, value?: string): Promise<{ ok: boolean; label: string; error?: string }> {
  if (step.action === "extract" || step.action === "wait") { await settle(); return { ok: true, label: step.target_description }; }
  dismissCookieBanner();
  const element = elementForReference(refId);
  if (!element) return { ok: false, label: "", error: "The selected element is no longer on the page." };
  element.scrollIntoView({ block: "center", inline: "nearest" });
  await outline(element, step.intent);
  if (step.action === "type" || step.action === "select") {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return { ok: false, label: accessibleName(element), error: "The selected element cannot accept a value." };
    element.focus(); setValue(element, value ?? "");
  } else (element as HTMLElement).click();
  await settle();
  return { ok: true, label: accessibleName(element) || element.tagName.toLowerCase() };
}

function context(element: Element): UnindexedStep["page_context"] {
  return { heading_hierarchy: Array.from(document.querySelectorAll("h1, h2, h3")).map((heading) => textOf(heading)).filter(Boolean), landmark: landmarkFor(element) };
}

function makeStep(type: UnindexedStep["type"], element: Element, value?: string): UnindexedStep {
  return { type, timestamp: Date.now(), url: location.href, page_title: document.title, target: targetFor(element), ...(value !== undefined ? { value } : {}), page_context: context(element) };
}

function makeNavigationStep(): UnindexedStep {
  const url = window.location.href;
  const pageTitle = document.title.trim() || url;
  return {
    type: "navigate", timestamp: Date.now(), url, page_title: pageTitle,
    target: {
      role: "document", accessible_name: pageTitle, tag: "html", text: "",
      attributes: { href: url },
      selector_candidates: [`url=${url}`, "document", "html"],
      bounding_box: { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
    },
    page_context: { heading_hierarchy: Array.from(document.querySelectorAll("h1, h2, h3")).map((heading) => textOf(heading)).filter(Boolean), landmark: "document" }
  };
}

function send(payload: CapturePayload): void {
  void safeRuntimeMessage({ type: "CAPTURE", payload } satisfies Message);
}

async function recorderIsActive(): Promise<boolean> {
  if (recording) return true;
  try {
    const response = await safeRuntimeMessage<StateResponse>({ type: "RECORDER_STATUS" } satisfies Message);
    if (!response) return false;
    recording = response.state.recording;
    return recording;
  } catch {
    return false;
  }
}

async function capture(type: UnindexedStep["type"], element: Element, value?: string): Promise<void> {
  if (!(await recorderIsActive())) return;
  const steps: UnindexedStep[] = [];
  if (pendingScroll && type !== "scroll") {
    const rect = element.getBoundingClientRect();
    if (rect.top >= 0 && rect.top <= window.innerHeight) steps.push(makeStep("scroll", document.body));
    pendingScroll = null;
  }
  steps.push(makeStep(type, element, value));
  send({ steps, snapshots: [snapshot(element)] });
}

async function navigation(): Promise<void> {
  if (!(await recorderIsActive()) || window.location.href === lastUrl) return;
  if (navigationTimer) window.clearTimeout(navigationTimer);
  const observedUrl = window.location.href;
  const record = (): void => {
    if (!recording) return;
    if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", () => window.setTimeout(record, 250), { once: true }); return; }
    if (window.location.href !== observedUrl) { void navigation(); return; }
    if (window.location.href === lastUrl) return;
    lastUrl = window.location.href;
    send({ steps: [makeNavigationStep()], snapshots: [snapshot(document.documentElement)] });
  };
  navigationTimer = window.setTimeout(record, 250);
}

document.addEventListener("click", (event) => {
  const element = event.target instanceof Element ? interactionTarget(event.target) : null;
  if (element) void capture("click", element);
}, true);
document.addEventListener("input", (event) => {
  const element = event.target;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return;
  if (inputTimer) window.clearTimeout(inputTimer);
  inputTimer = window.setTimeout(() => void capture("input", element, element.value), 500);
}, true);
document.addEventListener("change", (event) => {
  const element = event.target;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) return;
  const isToggle = element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type);
  if (!(element instanceof HTMLSelectElement || isToggle)) return;
  if (inputTimer) window.clearTimeout(inputTimer);
  void capture("change", element, isToggle && element instanceof HTMLInputElement ? String(element.checked) : element.value);
}, true);
window.addEventListener("scroll", () => { pendingScroll = { x: window.scrollX, y: window.scrollY, timestamp: Date.now() }; }, { passive: true });
window.addEventListener("popstate", () => void navigation());

const originalPushState = history.pushState;
history.pushState = function (data: unknown, unused: string, url?: string | URL | null): void {
  originalPushState.call(history, data, unused, url);
  queueMicrotask(() => void navigation());
};
const originalReplaceState = history.replaceState;
history.replaceState = function (data: unknown, unused: string, url?: string | URL | null): void {
  originalReplaceState.call(history, data, unused, url);
  queueMicrotask(() => void navigation());
};

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === "RECORDING_STARTED") { recording = true; sendResponse({ content_recorder: true, recording, url: window.location.href }); return; }
  if (message.type === "RECORDING_STOPPED") { recording = false; sendResponse({ content_recorder: true, recording, url: window.location.href }); return; }
  if (message.type === "EXECUTION_SNAPSHOT") { sendResponse({ url: location.href, nodes: runtimeNodes() }); return; }
  if (message.type === "EXECUTION_ACTION") { void executeAction(message.refId, message.step, message.value).then(sendResponse); return true; }
  if (message.type === "EXECUTION_ENABLE_POINTER") {
    const previousCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = "crosshair";
    const select = (event: MouseEvent): void => { document.documentElement.style.cursor = previousCursor; const target = event.target instanceof Element ? interactionTarget(event.target) : null; if (!target) return; event.preventDefault(); event.stopPropagation(); void safeRuntimeMessage({ type: "EXECUTION_POINTER_TARGET", stepId: message.stepId, role: roleOf(target), accessibleName: accessibleName(target) } satisfies Message); };
    document.addEventListener("click", select, { capture: true, once: true });
    sendResponse({ ok: true }); return;
  }
  sendResponse({ content_recorder: true, recording, url: window.location.href });
});

void safeRuntimeMessage<StateResponse>({ type: "RECORDER_STATUS" } satisfies Message).then((response) => {
  if (!response) return;
  recording = response.state.recording;
  if (recording) {
    lastUrl = "";
    void navigation();
  }
}).catch(() => undefined);
