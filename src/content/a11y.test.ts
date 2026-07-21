// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { accessibleName, interactionTarget } from "./a11y";

describe("clicked-element accessible names", () => {
  it("uses the nearest Gmail compose toolbar button, not the surrounding compose text", () => {
    document.body.innerHTML = `
      <div role="dialog">
        <div>Toamosomohodion1@gmail.com Cc Bcc Loading rich text Plain Text Check Spelling Resume Editing</div>
        <div class="toolbar">
          <div role="button" aria-label="More formatting options"><span id="format-icon">A</span><span>Formatting</span></div>
        </div>
      </div>`;

    const icon = document.getElementById("format-icon");
    expect(icon).not.toBeNull();
    const name = accessibleName(interactionTarget(icon!));

    expect(name).toBe("More formatting options");
    expect(name).toHaveLength(23);
    expect(name).not.toContain("Toamosomohodion1@gmail.com");
  });

  it("falls back to direct text only when no nearby interactive control exists", () => {
    document.body.innerHTML = `<div>Large wrapper text <span id="target">Small label</span><span>More wrapper text</span></div>`;
    const target = document.getElementById("target");
    expect(target).not.toBeNull();
    expect(accessibleName(target!)).toBe("Small label");
  });
});
