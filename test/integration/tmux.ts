/**
 * Tmux-only re-exports for integration tests.
 *
 * `surface.ts` (the backend-agnostic dispatch layer) does not export
 * `createSurfaceSplit`, so the harness imports it from the tmux module
 * via this local shim. Tmux-only tests must skip when tmux is absent
 * (see `getAvailableBackends()` in harness.ts) — never call these on the
 * process backend.
 */
export { createSurfaceSplit } from "../../pi-extension/subagents/tmux.ts";
