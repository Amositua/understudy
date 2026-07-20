import type { Message, StateResponse } from "../lib/messages";
import type { A11yNode, A11ySnapshot, CapturePayload, TargetDescriptor, UnindexedStep } from "../lib/types";

let recording = false;
let inputTimer: number | undefined;
let pendingScroll: { x: number; y: number; timestamp: number } | null = null;
let lastUrl = location.href;

const interactiveRoles = new Set(["button", "checkbox", "combobox", "link", "menuitem", "option", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox"]);
const landmarkRoles = new Set(["banner", "complementary", "contentinfo", "form", "main", "navigation", "region", "search"]);

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

function nameFromIds(ids: string | null): string {
  return (ids ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ").trim();
}

function accessibleName(element: Element): string {
  const explicit = element.getAttribute("aria-label") || nameFromIds(element.getAttribute("aria-labelledby"));
  if (explicit) return explicit.trim().slice(0, 200);
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    const label = element.labels?.[0]?.textContent?.trim();
    return (label || element.getAttribute("placeholder") || element.getAttribute("name") || element.value || "").slice(0, 200);
  }
  if (element instanceof HTMLImageElement) return element.alt.slice(0, 200);
  return (element.getAttribute("title") || textOf(element) || (element === document.documentElement ? document.title : "")).slice(0, 200);
}

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
    selected = nodes.filter((element) => keep.has(element));
  }
  const a11yNodes: A11yNode[] = selected.slice(0, 300).map((element) => ({ role: roleOf(element), accessible_name: accessibleName(element), reference_id: referenceId(element) }));
  return { url: location.href, timestamp: Date.now(), nodes: a11yNodes };
}

function context(element: Element): UnindexedStep["page_context"] {
  return { heading_hierarchy: Array.from(document.querySelectorAll("h1, h2, h3")).map((heading) => textOf(heading)).filter(Boolean), landmark: landmarkFor(element) };
}

function makeStep(type: UnindexedStep["type"], element: Element, value?: string): UnindexedStep {
  return { type, timestamp: Date.now(), url: location.href, page_title: document.title, target: targetFor(element), ...(value !== undefined ? { value } : {}), page_context: context(element) };
}

function send(payload: CapturePayload): void {
  if (!recording) return;
  chrome.runtime.sendMessage({ type: "CAPTURE", payload } satisfies Message).catch(() => undefined);
}

function capture(type: UnindexedStep["type"], element: Element, value?: string): void {
  if (!recording) return;
  const steps: UnindexedStep[] = [];
  if (pendingScroll && type !== "scroll") {
    const rect = element.getBoundingClientRect();
    if (rect.top >= 0 && rect.top <= window.innerHeight) steps.push(makeStep("scroll", document.body));
    pendingScroll = null;
  }
  steps.push(makeStep(type, element, value));
  send({ steps, snapshots: [snapshot(element)] });
}

function navigation(): void {
  if (!recording || location.href === lastUrl) return;
  lastUrl = location.href;
  send({ steps: [makeStep("navigate", document.documentElement)], snapshots: [snapshot(document.documentElement)] });
}

document.addEventListener("click", (event) => {
  const element = event.target instanceof Element ? event.target.closest("button, a, input, select, textarea, [role], [contenteditable=true]") ?? event.target : null;
  if (element) capture("click", element);
}, true);
document.addEventListener("input", (event) => {
  const element = event.target;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return;
  if (inputTimer) window.clearTimeout(inputTimer);
  inputTimer = window.setTimeout(() => capture("input", element, element.value), 500);
}, true);
document.addEventListener("change", (event) => {
  const element = event.target;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) return;
  const isToggle = element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type);
  if (!(element instanceof HTMLSelectElement || isToggle)) return;
  if (inputTimer) window.clearTimeout(inputTimer);
  capture("change", element, isToggle && element instanceof HTMLInputElement ? String(element.checked) : element.value);
}, true);
window.addEventListener("scroll", () => { pendingScroll = { x: window.scrollX, y: window.scrollY, timestamp: Date.now() }; }, { passive: true });
window.addEventListener("popstate", navigation);

const originalPushState = history.pushState;
history.pushState = function (data: unknown, unused: string, url?: string | URL | null): void {
  originalPushState.call(history, data, unused, url);
  queueMicrotask(navigation);
};
const originalReplaceState = history.replaceState;
history.replaceState = function (data: unknown, unused: string, url?: string | URL | null): void {
  originalReplaceState.call(history, data, unused, url);
  queueMicrotask(navigation);
};

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type === "RECORDING_STARTED") recording = true;
  if (message.type === "RECORDING_STOPPED") recording = false;
});

chrome.runtime.sendMessage({ type: "RECORDER_STATUS" } satisfies Message).then((response: StateResponse) => {
  recording = response.state.recording;
  if (recording) {
    lastUrl = "";
    navigation();
  }
}).catch(() => undefined);
