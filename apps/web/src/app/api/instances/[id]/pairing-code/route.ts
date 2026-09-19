import { guardInstance } from "../../../../../server/instance-guard";

/**
 * §7.3 `POST /api/instances/[id]/pairing-code`: a pairing code, for `code`-mode
 * pairing.
 *
 * Hermes pairs by QR only — its wizard prints a code to scan and offers no
 * number-matching flow — so this deployment cannot produce one. It answers a
 * refusal rather than a fabricated snapshot, and the console shows the reason:
 * `pairing-code` is the one route the screen calls that has no backend behind it.
 *
 * The tenant boundary is still checked first, so an operator cannot use this to
 * learn whether another organisation's instance id exists.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const guard = await guardInstance(id);
  if (!guard.ok) return guard.response;

  return Response.json(
    { error: "this deployment pairs by QR only — no pairing code is available", code: "unsupported" },
    { status: 501, headers: { "cache-control": "no-store" } },
  );
}
