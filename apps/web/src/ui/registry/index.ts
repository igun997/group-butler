/**
 * The registry's public surface (spec §2.1, §2.3): the three primitives' types,
 * the scope algebra, the ten declared views, and the resolution from an address
 * to a view, a scope, and validated params. Consumers import from here, never
 * from a sibling module, so the internal split (algebra vs catalog) stays an
 * implementation detail.
 */
export * from "./types";
export { canonicalPath, encodeScope, matchRoute, normalizeScope, pathSegments, scopeOf, type RouteMatch } from "./scope";
export {
  parseScope,
  registerView,
  resolveView,
  views,
  viewsFor,
  type ResolvedView,
} from "./registry";
export {
  MESSAGE_KINDS,
  VIEW_PARAMS,
  cursorParam,
  parseParams,
  serializeParams,
  type ParamValue,
  type ViewParams,
} from "./params";
