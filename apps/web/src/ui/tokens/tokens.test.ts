import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  BREAKPOINT,
  FOCUS,
  MENU,
  MOTION,
  PAIRING,
  PALETTE,
  RADIUS,
  RESOURCE,
  ROW_HEIGHT,
  SHEET,
  SHELL,
  SHADOW,
  SPACE,
  SURFACE,
  TARGET,
  TYPE_RAMP,
} from "./index";

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

    // The resource surfaces' warm bar (R-L3) is a named value like everything
    // else `globals.css` consumes.
    expect(light.get("--resource-bar-height")).toBe(`${RESOURCE.barHeight}px`);
    expect(light.get("--resource-bar-cycle")).toBe(`${RESOURCE.barCycleMs}ms`);

    // The pairing surface's QR geometry (P6, R-L5) is a named value too.
    expect(light.get("--pairing-qr-size")).toBe(PAIRING.qrSize);

    // The interactive floor, the modal surfaces, and the scrim are tokens too:
    // a control, a palette, and a sheet consume the same values, not their own.
    for (const [name, px] of Object.entries(TARGET)) {
      expect(light.get(asToken(`--target-${name}`))).toBe(`${px}px`);
    }
    for (const [name, px] of Object.entries(SURFACE)) {
      expect(light.get(asToken(`--surface-${name}`))).toBe(`${px}px`);
    }
    for (const [name, value] of Object.entries(SHEET)) {
      expect(light.get(asToken(`--sheet-${name}`))).toBe(value);
    }
    // The palette's offset and list cap, the owner menu's width, and how much of
    // a phone the owner's address may take are named for the same reason.
    expect(light.get("--palette-offset-block")).toBe(PALETTE.offsetBlock);
    expect(light.get("--palette-list-max-height")).toBe(PALETTE.listMaxHeight);
    expect(light.get("--menu-min-width")).toBe(`${MENU.minWidth}px`);
    expect(light.get("--menu-label-max-width")).toBe(MENU.labelMaxWidth);
    for (const [name, px] of Object.entries(BREAKPOINT)) {
      expect(light.get(asToken(`--breakpoint-${name}`))).toBe(`${px}px`);
    }
    expect(light.get("--scrim")).toBe("color-mix(in srgb, var(--foreground) 40%, transparent)");

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

  /*
   * P0's stated proof — "every value consumed by name, no raw hex or px" — was a
   * grep over the components, and a grep is not a gate. This is that proof as a
   * test over the shell's and the spine's own sources, so a hand-written colour or
   * pixel length fails the suite instead of a reviewer's eye.
   */
  test("the shell and spine components name their values instead of writing them", () => {
    const sources = [
      "../../components/app-shell.tsx",
      "../../components/command-palette.tsx",
      "../../components/toaster.tsx",
      "../../components/scope-spine.tsx",
      "../../components/jid-cell.tsx",
      "../../components/group-name-cell.tsx",
      "../../components/state-badges.tsx",
      // P5's surfaces are held to the same rule: the workspace shell that wires
      // the registry, the header and live indicator it renders, the media query
      // that picks a presentation, and the groups workspace itself.
      "../../components/workspace-shell.tsx",
      "../../components/workspace-header.tsx",
      "../../components/live-indicator.tsx",
      "../../components/media-query.ts",
      "../../components/utc-stamp.ts",
      "../../components/provenance.ts",
      "../../components/subject-history-sheet.tsx",
      "../registry/views/groups/index.tsx",
      "../registry/views/groups/columns.tsx",
      "../registry/views/groups/panel.tsx",
      "../registry/views/groups/resources.tsx",
      // P6's two workspaces are held to it as well: the estate list, the
      // instance page's session, pairing and configuration surfaces, and the
      // create form.
      "../registry/views/instances/index.tsx",
      "../registry/views/instances/columns.tsx",
      "../registry/views/instances/create-instance.tsx",
      "../registry/views/instances/panel.tsx",
      "../registry/views/instances/resources.tsx",
      "../registry/views/instance/index.tsx",
      "../registry/views/instance/panel.tsx",
      "../registry/views/instance/pairing.tsx",
      "../registry/views/instance/resources.tsx",
      "../registry/views/instance/whitelist.tsx",
      // The banner surface P6 landed with them (R-X2, R-X3).
      "../../components/error-banner.tsx",
    ] as const;
    const raw = /#[0-9a-fA-F]{3,8}\b|\b\d+(\.\d+)?px\b/g;

    for (const source of sources) {
      const component = readFileSync(new URL(source, import.meta.url), "utf8");
      expect([source, component.match(raw) ?? []]).toEqual([source, []]);
    }
  });

  /*
   * And the same rule for the stylesheets the shell and the spine own (§2.2
   * invariant 5: the surfaces are the token layer's consumers). The scanned
   * region is the P1 banner through the end of the file — the shell's chrome and
   * the P2 scope spine — with comments and media preludes removed, because the
   * breakpoint test above already governs those. Anything else that is not a
   * `var(--…)` reference or a full-bleed declaration is a value that belongs in
   * the token layer.
   */
  test("the shell and spine stylesheets write no layout value of their own", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    const surfaces = css
      .slice(css.indexOf("P1 — the one shell"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@media[^{]+/g, "");

    const length = /(?<![\w-])\d*\.?\d+(px|rem|em|ch|ex|vh|vw|vmin|vmax|dvh|dvw|%)(?![\w-])/g;
    const fullBleed = /^100(vh|vw|dvh|dvw|%)$/;
    const literals = [...surfaces.matchAll(length)].map((match) => match[0]);

    // The scan has something to look at, so a renamed banner cannot pass it.
    expect(literals.length).toBeGreaterThan(0);
    expect(literals.filter((value) => !fullBleed.test(value))).toEqual([]);
  });

  /*
   * R-M2 collapses the chrome below `md` and R-T3 moves the toasts below `sm`, and
   * a media query cannot read a custom property — so the stylesheet writes the
   * literal and this holds every one of them to the named boundary. A new
   * breakpoint must be named in the token layer before it can be used.
   */
  test("every media boundary in the stylesheet is a named breakpoint", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    const boundaries = [...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map((match) =>
      Number(match[1]),
    );

    expect(boundaries.length).toBeGreaterThan(0);
    expect(new Set(boundaries)).toEqual(new Set(Object.values(BREAKPOINT)));
  });

  /*
   * R-A4 held against the failure a control whose fill IS the ring exposes: with
   * the inner line authored in `--foreground`, the primary submit button — whose
   * background is `--foreground`, and in the light theme `--ring` is that same
   * neutral — carried an indicator at 1:1 on the control in both themes. The pair
   * is now inner light / outer dark, so the control and the page each get a
   * channel that reads.
   */
  test("the focus rectangle clears 3:1 on every surface a control can take, button and input included", () => {
    const css = readFileSync(new URL("./fluent.css", import.meta.url), "utf8");
    // The focus tokens are declared once on `:root` in terms of the theme's own
    // colours, so each theme is that base with its colour block cascaded over it —
    // exactly how the browser resolves them.
    const base = declarations(css, ":root");
    const themes = { light: base, dark: new Map([...base, ...declarations(css, ":root.dark")]) };
    // Every fill a focusable control can be drawn with, or sit on: the page and
    // its surfaces, the form controls, and the filled buttons.
    const surfaces = [
      "background",
      "card",
      "popover",
      "input",
      "muted",
      "secondary",
      "accent",
      "primary",
      "destructive",
    ];

    for (const [theme, tokens] of Object.entries(themes)) {
      const inner = resolve(tokens, "--focus-inner");
      const outer = resolve(tokens, "--focus-outer");
      const page = resolve(tokens, "--background");
      const primary = resolve(tokens, "--primary");

      // Two tones, and the ring is the channel the page sees, so it clears the
      // floor against the page on its own.
      expect([theme, inner === outer]).toEqual([theme, false]);
      expect([theme, contrast(outer, page) >= 3]).toEqual([theme, true]);

      for (const surface of surfaces) {
        const fill = resolve(tokens, `--${surface}`);
        const visible = contrast(inner, fill) >= 3 || contrast(outer, fill) >= 3;
        expect([theme, surface, visible]).toEqual([theme, surface, true]);
      }

      // The primary control: its fill is the ring's own tone, so only the inner
      // line can carry the indicator. This is the case the review blocked on.
      expect([theme, contrast(outer, primary) < 3, contrast(inner, primary) >= 3]).toEqual([theme, true, true]);
    }

    // One global treatment applies the pair to every focusable element: the ring
    // as an outline, the neutral line as the shadow layer filling the 1 px offset.
    const focus = declarations(css, ":focus-visible");
    expect(focus.get("outline")).toBe("var(--focus-ring-width) solid var(--focus-outer)");
    expect(focus.get("outline-offset")).toBe("var(--focus-ring-offset)");
    expect(focus.get("box-shadow")).toBe("var(--focus-inner-line)");
  });

  /*
   * §3.2 asks for "a system UI stack with a bundled fallback face" and the
   * appendix names it, Inter. Naming a family in a stack is not a bundled face,
   * so this holds the asset, its licence, the @font-face and the stack position
   * together — the claim the first round got wrong.
   */
  test("the bundled fallback face is a real Inter asset, licensed, declared and last in the stack", () => {
    const css = readFileSync(new URL("./fluent.css", import.meta.url), "utf8");
    const face = declarations(css, "@font-face");
    const family = (face.get("font-family") ?? "").replace(/["']/g, "");
    const source = /url\("([^"]+)"\)/.exec(face.get("src") ?? "")?.[1] ?? "";

    expect(family).toBe("Inter");
    expect(source.startsWith("/fonts/")).toBe(true);
    expect(face.get("font-display")).toBe("swap");

    // A real woff2 beside its OFL licence, both inside `public/` so Next serves
    // them and the runtime image copies them.
    const asset = readFileSync(new URL(`../../../public${source}`, import.meta.url));
    const licence = readFileSync(new URL("../../../public/fonts/Inter-OFL.txt", import.meta.url), "utf8");
    expect(asset.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(asset.length).toBeGreaterThan(10_000);
    expect(licence).toContain("SIL Open Font License");
    expect(licence).toContain("Inter Project Authors");

    // The one face covers every weight the ramp asks for.
    const [minimum, maximum] = (face.get("font-weight") ?? "").split(/\s+/).map(Number);
    for (const step of Object.values(TYPE_RAMP)) {
      expect([step.weight, minimum! <= step.weight && step.weight <= maximum!]).toEqual([step.weight, true]);
    }

    // Stack position: system-led, the bundled face as the fallback, generic last.
    const stack = (declarations(css, ":root").get("--font-ui") ?? "").split(",").map((entry) => entry.trim());
    expect(stack).toContain(`"${family}"`);
    expect(stack.indexOf('"Segoe UI"')).toBeLessThan(stack.indexOf(`"${family}"`));
    expect(stack.indexOf(`"${family}"`)).toBeLessThan(stack.indexOf("sans-serif"));
  });
});

/** `sheetTop` is `sheet-top` in a custom property name. */
function asToken(camelName: string): string {
  return camelName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** A token's value with its `var(--other)` references followed to the theme's own value. */
function resolve(tokens: Map<string, string>, name: string): string {
  let value = tokens.get(name) ?? "";
  for (let depth = 0; depth < 4 && value.startsWith("var("); depth += 1) {
    value = tokens.get(value.slice(4, value.indexOf(")")).trim()) ?? value;
  }
  return value;
}

/** WCAG relative-luminance contrast ratio between two `#rrggbb` token values. */
function contrast(one: string, other: string): number {
  const luminance = (hex: string) =>
    [1, 3, 5]
      .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const [high, low] = [luminance(one), luminance(other)].sort((left, right) => right - left);
  return (high! + 0.05) / (low! + 0.05);
}

/**
 * Every declaration of every rule whose selector is exactly `selector`, names and
 * values whitespace-normalised, optionally requiring the rule to sit directly
 * inside `atRule` (so the same selector in two environments — the OS theme media
 * query, the reduced-motion override — is not conflated).
 */
function declarations(css: string, selector: string, atRule: string | null = null): Map<string, string> {
  const found = new Map<string, string>();
  for (const rule of rules(css.replace(/\/\*[\s\S]*?\*\//g, ""), null)) {
    if (rule.head !== selector || rule.atRule !== atRule) continue;
    for (const declaration of rule.body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon === -1) continue;
      found.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).replace(/\s+/g, " ").trim());
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
