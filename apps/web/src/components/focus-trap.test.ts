import { type Mock, describe, expect, test, vi } from "vitest";
import { trapTabKey, type TabKeyEvent } from "./focus-trap";

interface FakeControl {
  focused: boolean;
  focus(): void;
}

function control(): FakeControl {
  return {
    focused: false,
    focus() {
      this.focused = true;
    },
  };
}

/** A layer whose focusable children are the given controls, with one of them active. */
function layer(count: number, activeIndex: number) {
  const controls = Array.from({ length: count }, control);
  const active = activeIndex < 0 ? null : controls[activeIndex];
  const container = {
    querySelectorAll: () => controls,
    contains: (node: unknown) => controls.includes(node as FakeControl),
    ownerDocument: { activeElement: active },
  };
  return { container: container as unknown as HTMLElement, controls };
}

interface SpiedTabEvent extends TabKeyEvent {
  preventDefault: Mock;
}

function keyEvent(key: string, shiftKey: boolean): SpiedTabEvent {
  return { key, shiftKey, preventDefault: vi.fn() };
}

describe("trapTabKey (R-A1 focus containment in a modal layer)", () => {
  test("wraps forward from the last control to the first", () => {
    const { container, controls } = layer(2, 1);
    const event = keyEvent("Tab", false);

    trapTabKey(container, event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(controls[0]!.focused).toBe(true);
    expect(controls[1]!.focused).toBe(false);
  });

  test("wraps backward from the first control to the last", () => {
    const { container, controls } = layer(2, 0);
    const event = keyEvent("Tab", true);

    trapTabKey(container, event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(controls[1]!.focused).toBe(true);
    expect(controls[0]!.focused).toBe(false);
  });

  test("leaves focus alone between controls, so the browser still moves it", () => {
    const { container, controls } = layer(3, 1);
    const event = keyEvent("Tab", false);

    trapTabKey(container, event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(controls.some((item) => item.focused)).toBe(false);
  });

  test("pulls focus back in when it is outside the layer", () => {
    const { container, controls } = layer(2, -1);
    const event = keyEvent("Tab", false);

    trapTabKey(container, event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(controls[0]!.focused).toBe(true);
  });

  test("ignores keys other than Tab and an empty layer", () => {
    const enter = keyEvent("Enter", false);
    trapTabKey(layer(2, 0).container, enter);
    expect(enter.preventDefault).not.toHaveBeenCalled();

    const empty = keyEvent("Tab", false);
    trapTabKey(layer(0, -1).container, empty);
    expect(empty.preventDefault).not.toHaveBeenCalled();
  });
});
