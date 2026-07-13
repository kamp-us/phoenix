/**
 * @kampus/local-render — the local render-and-capture harness (#2963, epic #2953).
 *
 * Renders the composed UI surface of the app over a running local `alchemy dev`
 * build and writes per-surface PNG(s) to disk, honoring the dev-override cookie
 * (flag-gated UI) and an empty local D1 (designed-empty states), with capture-side
 * crop/downscale under a documented budget. Reuses `@kampus/design-capture`'s
 * `captureShots`/`buildCapturePlan`/viewport primitives as the Playwright leg —
 * it adds local-build targeting on top, it does not re-implement browser capture.
 */
export type {CaptureDirective, LocalShotOptions} from "./plan.ts";
export {
	buildLocalShots,
	buildOverrideCookies,
	DEFAULT_LOCAL_BASE,
	FLAG_OVERRIDE_COOKIE,
	LONGEST_EDGE_BUDGET,
	normalizeClip,
	planCaptureDirective,
	resolveLocalBase,
} from "./plan.ts";
export type {CaptureLeg, LocalRenderDeps, LocalRenderRequest} from "./render.ts";
export {renderLocal} from "./render.ts";
