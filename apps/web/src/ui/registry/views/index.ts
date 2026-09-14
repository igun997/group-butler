/**
 * The view catalog (docs/ui-decision.md §2.2 invariant 5, §2.5).
 *
 * Importing a view's module is what registers it: each module completes the
 * address the registry declared and calls `registerView` once, at import time,
 * with no dynamic loading, no manifest, and no descriptor serialization. This
 * barrel is therefore the one list to extend when a workspace is added, and it is
 * imported by the shell — the shell reads the catalog, it never enumerates
 * workspaces itself.
 */

import { groupsView } from "./groups";

export { groupsView };
