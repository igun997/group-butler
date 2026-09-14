# Group Butler — design direction

Direction record for the web surfaces in `apps/web`. Kept short on purpose: it holds the
fields the work is judged against, not prose.

## Product and users

- **What**: the operator console for a single organisation's WhatsApp groups. It watches what a
  linked account captures, gates outbound sends behind approval, and reports what the worker is
  doing.
- **Who**: one internal operator (the owner account), at a desk, during working hours, mostly
  checking "is the capture healthy" and "what needs my approval".
- **Register**: **product** (design serves the work), not brand.

## Reading

> Reading this as: internal operator console for a single WhatsApp-group operator, in a
> restrained neutral (shadcn `base-maia`) language, dial ENERGY 1 / RHYTHM 1 / MOTION 2.

Reference the owner supplied: `vibedeveloper.id/user/auth` (centred auth panel, segmented control,
icon theme toggle, light/dark). Used as **structure inspiration only**; see "Deliberate
divergences".

## Palette

Restrained strategy: tinted neutrals from `base-maia` (stone, OKLCH) plus colour that **only ever
encodes state**.

| Role | Token | Why |
| --- | --- | --- |
| Surfaces / text | `background`, `foreground`, `card`, `muted`, `border` | shadcn's own stone ramp, already in `globals.css`; no new palette to maintain. |
| Primary action | `primary` (near-black in light, near-white in dark) | The console has exactly one primary action per screen (sign in). Colour is not spent here, so it stays available for state. |
| Live state | `success` | A connected, capturing instance is the healthy state. |
| Waiting state | `warning` | Pairing is in progress and needs the operator, not a retry. |
| Failure state | `destructive` | Errors only. |
| Inactive state | `muted-foreground` | Disconnected, logged out, left. |

Every state pair was measured, not eyeballed. Text on its own 10% tint, light / dark:

| Pair | Light | Dark | Floor |
| --- | --- | --- | --- |
| `success` on `success/10` | 4.82 | 8.49 | 4.5 |
| `warning` on `warning/10` | 4.89 | 9.52 | 4.5 |
| `destructive` on `destructive/5` | 5.58 | 6.56 | 4.5 |
| `muted-foreground` on `card` | 4.79 | 7.64 | 4.5 |
| `foreground` on `card` | 19.76 | 16.74 | 3 |

Three lightness values sit below shadcn's stock ones so those floors hold. `--destructive` is the
one stock token changed: at its default 0.577 lightness the destructive text was 4.36:1 on its own
5% tint.

Colour never appears as decoration: not on headings, not on rules, not on the brand lockup.

## Typography

| Role | Face | Why |
| --- | --- | --- |
| Everything | Geist (`--font-sans`) | One family across headings, body, controls and data. It is an interface face with matching tabular figures, so numbers in a column line up, and it keeps the console visually identical to the interface language the owner already reads (the reference site uses it too). |
| JIDs, ids, counts | Geist Mono (`--font-mono`) | The same family's mono, used only for the machine strings the operator copies. `font-heading` resolves to the sans, so a generated component cannot re-introduce a second face. |

## Identity motif

**Group addresses are always set as copyable monospace identifiers** with the server suffix muted
(`12036304…@g.us`). It is the one thing this product has that nothing else does, it repeats on
every screen, and it doubles as the copy affordance.

## Layout

- **Private shell**: shadcn `sidebar` (collapsible, offcanvas on mobile) + a topbar carrying the
  page title, the theme control, and the account menu. Content lives in one `main`.
- **Public shell**: a single centred panel on a flat background. No page decoration.
- **Spacing**: page padding `p-4` mobile / `p-6` desktop; gaps from the Tailwind scale, not
  hand-tuned values.

## Deliberate divergences from the reference

| Reference | Here | Why |
| --- | --- | --- |
| Gold CTA with black text in dark mode | Neutral `primary` in both themes | The gold is VibeDev's identity. This console's colour is reserved for state; a decorative CTA colour would compete with it. |
| Dot-grid page background | Flat `background` | A dot grid is texture with no job here (antislop R-07). |
| "Sign up" tab, Google/GitHub buttons, "Forgot password?" | Removed | This product has no signup, no OAuth, and no password reset (single server-configured owner). Shipping the controls would be dead UI (antislop R-24, R-26). |
| "By signing in you agree to our Terms & Service" | Removed | There is no terms page in this repo to link to. |

## Motion

MOTION 2: the light/dark swap is the one animation that carries meaning, so it is the one that
runs site-wide: a View Transition clips the incoming theme into a circle growing from the control
the owner pressed (450ms, `cubic-bezier(0.22, 1, 0.36, 1)`, ease-out only). Everything else is
shadcn's own hover/active feedback plus the shell's disclosure motion. `prefers-reduced-motion:
reduce` skips the reveal entirely and swaps instantly, and a browser without the API falls back to
the same instant swap.

## Decisions, one line each

- **Centred panel for sign-in**: the screen has exactly one job, so it gets one focal point.
- **Sidebar over top-nav for the console**: the operator switches between two or three
  destinations repeatedly; a persistent rail costs less than a menu each time.
- **Status as a badge, not a dot**: the badge carries the state word, so the meaning survives
  without colour.
- **`GB` monogram in a plain tile**: the rail needs a mark and the product has no logo asset, so it
  uses the sanctioned placeholder (initials beside the wordmark), not an invented logo.
- **Theme swap animated, nothing else**: motion is spent where the owner's action changes the whole
  screen; adding entrance animations elsewhere would only delay reading.
- **Empty states name the cause and the next step**: instance rows only appear once an instance is
  created, which happens outside this shell today, so the empty state says exactly that.
