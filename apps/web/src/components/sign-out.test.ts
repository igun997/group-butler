import { describe, expect, test } from "vitest";
import { signOut, type SignOutFetch } from "./sign-out";

describe("signOut (R-A6 keyboard path to the owner's one action)", () => {
  test("posts to the logout route and reports the server's answer", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchImpl: SignOutFetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(null, { status: 200 });
    };

    await expect(signOut(fetchImpl)).resolves.toBe(true);
    expect(calls).toEqual([{ input: "/api/auth/logout", init: { method: "POST" } }]);
  });

  test("reports failure when the route refuses or the server is unreachable", async () => {
    await expect(signOut(async () => new Response(null, { status: 503 }))).resolves.toBe(false);
    await expect(
      signOut(async () => {
        throw new Error("offline");
      }),
    ).resolves.toBe(false);
  });
});
