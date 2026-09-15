import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { OwnerWhitelistForm } from "./owner-whitelist-form";

describe("owner whitelist form", () => {
  test("shows safe phone displays rather than full stored JIDs", () => {
    const html = renderToStaticMarkup(<OwnerWhitelistForm authorizedJids={["628990000001@s.whatsapp.net"]} />);

    expect(html).toContain("62••••0001");
    expect(html).not.toContain("628990000001@s.whatsapp.net");
  });

  test("explains the disabled empty state and has a real save control", () => {
    const html = renderToStaticMarkup(<OwnerWhitelistForm authorizedJids={[]} />);

    expect(html).toMatch(/automatic replies are disabled/i);
    expect(html).toContain("Add owner phone");
    expect(html).toContain("Save authorized owners");
  });
});
