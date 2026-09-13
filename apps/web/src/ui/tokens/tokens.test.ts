import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FOCUS, MOTION, RADIUS, ROW_HEIGHT, SHELL, SHADOW, SPACE, TYPE_RAMP } from "./index";

describe("token layer (spec §3.2)", () => {
  test("spatial scale is the 4px grid with the specified steps", () => {
    expect(Object.values(SPACE)).toEqual([4, 8, 12, 16, 24, 32, 48]);
  });

  test("radius, row heights and shell chrome match the spec", () => {
    expect(RADIUS).toEqual({ control: 4, panel: 8, dialog: 12, sheetTop: 16 });
    expect(ROW_HEIGHT).toEqual({ comfortable: 40, compact: 32, header: 36 });
  });

  test("motion durations and curves are feedback-only", () => {
    expect(MOTION.duration).toEqual({ state: 100, enter: 150, panel: 200, sheet: 300 });
    expect(MOTION.curve.standard).toBe("cubic-bezier(.33,0,.67,1)");
    expect(MOTION.curve.decelerate).toBe("cubic-bezier(0,0,0,1)");
    expect(MOTION.curve.accelerate).toBe("cubic-bezier(1,0,1,1)");
  });

  test("the type ramp exposes the seven defined steps", () => {
    expect(Object.keys(TYPE_RAMP)).toEqual(
      ["caption", "body", "bodyStrong", "subtitle", "title3", "title2", "display"],
    );
  });

  /*
   * Beyond the four tests the task plan specifies, because elevation, shell
   * chrome, focus, and the ramp's values are exactly what a hand edit can
   * silently drift from §3.2, and because nothing else fails if the CSS table
   * and these modules stop agreeing. This is §5 P0's stated proof — a token
   * table diffed against §3.2, in both shipped themes — held by a test.
   */
  test("the full table matches §3.2 and fluent.css declares it in both themes", () => {
    expect(SHELL).toEqual({ header: 48, spine: 40, sidebar: 240, rail: 48 });
    expect(FOCUS).toEqual({ width: 2, offset: 1, inner: "var(--focus-inner)", outer: "var(--focus-outer)" });
    expect(TYPE_RAMP).toEqual({
      caption: { size: 12, lineHeight: 16, weight: 400 },
      body: { size: 14, lineHeight: 20, weight: 400 },
      bodyStrong: { size: 14, lineHeight: 20, weight: 600 },
      subtitle: { size: 16, lineHeight: 22, weight: 600 },
      title3: { size: 20, lineHeight: 26, weight: 600 },
      title2: { size: 24, lineHeight: 32, weight: 600 },
      display: { size: 28, lineHeight: 36, weight: 600 },
    });
    expect(SHADOW).toEqual({
      4: "0 2px 4px rgb(0 0 0 / .14), 0 0 2px rgb(0 0 0 / .12)",
      8: "0 4px 8px rgb(0 0 0 / .14), 0 0 2px rgb(0 0 0 / .12)",
      16: "0 8px 16px rgb(0 0 0 / .14), 0 0 2px rgb(0 0 0 / .12)",
      28: "0 14px 28px rgb(0 0 0 / .24), 0 0 8px rgb(0 0 0 / .20)",
    });

    const css = readFileSync(new URL("./fluent.css", import.meta.url), "utf8");
    const light = declarations(css, ":root");
    const darkBySystem = declarations(css, ":root:not(.light)", "@media (prefers-color-scheme: dark)");
    const darkByClass = declarations(css, ":root.dark");

    // §3.4: one `.dark` class flips the same names the OS-dark block does, and
    // no token is authored for one theme only — every override is a value for a
    // name the light reference already declares.
    expect([...darkByClass.keys()]).toEqual([...darkBySystem.keys()]);
    expect(darkByClass.size).toBeGreaterThan(10);
    for (const name of [...darkByClass.keys(), ...darkBySystem.keys()]) {
      expect([name, light.has(name)]).toEqual([name, true]);
    }
    for (const name of [
      "background",
      "foreground",
      "card",
      "card-foreground",
      "popover",
      "popover-foreground",
      "primary",
      "primary-foreground",
      "secondary",
      "secondary-foreground",
      "muted",
      "muted-foreground",
      "accent",
      "accent-foreground",
      "destructive",
      "destructive-foreground",
      "border",
      "input",
      "ring",
    ]) {
      expect([name, light.has(`--${name}`)]).toEqual([name, true]);
    }

    // Every numeric table is declared under the same name in the CSS, so a
    // consumer reaching for either source gets the same value.
    for (const [step, px] of Object.entries(SPACE)) expect(light.get(`--space-${step}`)).toBe(`${px}px`);
    for (const [name, px] of Object.entries(RADIUS)) expect(light.get(asToken(`--radius-${name}`))).toBe(`${px}px`);
    for (const [name, px] of Object.entries(ROW_HEIGHT)) {
      expect(light.get(asToken(`--row-height-${name}`))).toBe(`${px}px`);
    }
    for (const [name, px] of Object.entries(SHELL)) expect(light.get(asToken(`--shell-${name}`))).toBe(`${px}px`);
    for (const [elevation, shadow] of Object.entries(SHADOW)) {
      expect(light.get(`--elevation-${elevation}`)).toBe(shadow);
    }
    for (const [name, ms] of Object.entries(MOTION.duration)) {
      expect(light.get(asToken(`--motion-duration-${name}`))).toBe(`${ms}ms`);
    }
    for (const [name, curve] of Object.entries(MOTION.curve)) {
      expect(light.get(asToken(`--motion-curve-${name}`))).toBe(curve);
    }
    for (const [name, step] of Object.entries(TYPE_RAMP)) {
      expect(light.get(asToken(`--type-${name}-size`))).toBe(`${step.size}px`);
      expect(light.get(asToken(`--type-${name}-line`))).toBe(`${step.lineHeight}px`);
      expect(light.get(asToken(`--type-${name}-weight`))).toBe(`${step.weight}`);
    }
    expect(light.get("--focus-ring-width")).toBe(`${FOCUS.width}px`);
    expect(light.get("--focus-ring-offset")).toBe(`${FOCUS.offset}px`);

    // The acrylic material and its opaque fallback are a P0 contract (§3.2,
    // R-A9), not something a surface re-invents.
    expect(light.get("--acrylic-blur")).toBe("30px");
    expect(light.get("--acrylic-saturate")).toBe("125%");
    expect(css).toContain(".acrylic");
    expect(css).toContain("prefers-reduced-transparency: reduce");

    // The motion floor is a token override, not a branch in a component: under
    // `prefers-reduced-motion` every duration a consumer reads is zero (R-L7).
    const still = declarations(css, ":root", "@media (prefers-reduced-motion: reduce)");
    expect([...still.keys()]).toEqual(Object.entries(MOTION.duration).map(([name]) => `--motion-duration-${name}`));
    for (const ms of still.values()) expect(ms).toBe("0ms");
  });
});

/** `sheetTop` is `sheet-top` in a custom property name. */
function asToken(camelName: string): string {
  return camelName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * The custom properties declared by every rule whose selector is exactly
 * `selector`, values whitespace-normalised, optionally requiring the rule to sit
 * directly inside `atRule` (so the same selector in two environments — the OS
 * theme media query, the reduced-motion override — is not conflated).
 */
function declarations(css: string, selector: string, atRule: string | null = null): Map<string, string> {
  const found = new Map<string, string>();
  for (const rule of rules(css.replace(/\/\*[\s\S]*?\*\//g, ""), null)) {
    if (rule.head !== selector || rule.atRule !== atRule) continue;
    for (const declaration of rule.body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon === -1) continue;
      const name = declaration.slice(0, colon).trim();
      if (name.startsWith("--")) found.set(name, declaration.slice(colon + 1).replace(/\s+/g, " ").trim());
    }
  }
  return found;
}

interface Rule {
  head: string;
  body: string;
  atRule: string | null;
}

/** Every rule in `css`, including one level inside an at-rule. */
function rules(css: string, atRule: string | null): Rule[] {
  const found: Rule[] = [];
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    if (open === -1) break;
    const previous = Math.max(css.lastIndexOf("}", open - 1), css.lastIndexOf("{", open - 1));
    const head = css.slice(previous + 1, open).trim();

    let depth = 0;
    let close = open;
    for (; close < css.length; close += 1) {
      if (css[close] === "{") depth += 1;
      else if (css[close] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    const body = css.slice(open + 1, close);
    if (body.includes("{")) found.push(...rules(body, head));
    else found.push({ head, body, atRule });

    cursor = close + 1;
  }
  return found;
}
