const interactiveSelector = "button, a[href], input, select, textarea, [contenteditable=true], [role=button], [role=link], [role=checkbox], [role=combobox], [role=menuitem], [role=option], [role=radio], [role=searchbox], [role=switch], [role=tab], [role=textbox]";
const ancestorStopSelector = "button, [role=button], [aria-label]";

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cap(value: string, limit = 60): string {
  const clean = normalize(value);
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/** Returns only text nodes directly owned by this element, never descendant text. */
function directText(element: Element): string {
  return cap(Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join(" "), 40);
}

function localName(element: Element): string {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return cap(ariaLabel);

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return cap(element.labels?.[0]?.textContent ?? element.getAttribute("placeholder") ?? element.getAttribute("name") ?? "");
  }
  if (element instanceof HTMLImageElement && element.alt) return cap(element.alt);

  return cap(element.getAttribute("title") ?? directText(element));
}

/** Finds a real control to describe, never a broad wrapper chosen solely for its text. */
export function interactionTarget(target: Element): Element {
  return target.closest(interactiveSelector) ?? target;
}

/**
 * Produces a compact, element-local label.  It intentionally does not use
 * innerText/textContent on containers because those include all descendants.
 */
export function accessibleName(element: Element): string {
  const exactName = localName(element);
  if (exactName) return exactName;

  let ancestor = element.parentElement;
  for (let level = 0; ancestor && level < 2; level += 1, ancestor = ancestor.parentElement) {
    if (ancestor.matches(ancestorStopSelector)) {
      // Stop at the first qualifying control, even if it is otherwise unnamed.
      return localName(ancestor) || cap(ancestor.tagName.toLowerCase());
    }
  }

  return cap([element.tagName.toLowerCase(), element.getAttribute("aria-label") ?? "", directText(element)]
    .filter(Boolean)
    .join(" "));
}
