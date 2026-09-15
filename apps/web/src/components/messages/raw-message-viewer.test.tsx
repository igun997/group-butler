import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/messages" }));

import { RawMessageViewer } from "./raw-message-viewer";

describe("raw message viewer", () => {
  test("offers an explicit keyboard control without embedding raw data in the transcript", () => {
    const html = renderToStaticMarkup(<RawMessageViewer instanceId="inst_1" messageId="wamid-1" />);

    expect(html).toContain("View raw message");
    expect(html).not.toContain("conversation");
    expect(html).toContain("button");
  });
});
