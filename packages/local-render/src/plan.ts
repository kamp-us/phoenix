/**
 * The pure core of the local render-and-capture harness (#2963, epic #2953):
 * resolve the localhost base the running dev build serves, build the
 * dev-override cookie that un-gates flag-gated surfaces locally, and compute the
 * crop/downscale directive that keeps captured images under the vision-loop
 * budget. No browser, no network — this is the unit-tested selection logic; the
 * impure Playwright leg (`@kampus/design-capture`'s `captureShots`) is driven
 * over the plan this produces (see `render.ts`).
 *
 * Local-build targeting, not preview targeting: `@kampus/design-capture` shoots
 * a *deployed* preview URL and `@kampus/audit-run` a *deployed* stage — nothing
 * targeted a local `alchemy dev` build. This adds that targeting on top of
 * design-capture's plan/viewport/capture primitives without re-implementing
 * browser capture.
 */
import {
	buildCapturePlan,
	type CaptureClip,
	type CaptureCookie,
	DEFAULT_VIEWPORT,
	type Shot,
	type Surface,
	type Viewport,
} from "@kampus/design-capture";

/**
 * The default localhost base the composed UI surface is served from under
 * `pnpm dev`: the Vite dev server (`vite.config.ts` `server.port`), which serves
 * the React SPA shell + HMR and proxies `/api` and `/fate` to the `alchemy dev`
 * worker (vhost-routed at `http://phoenix.localhost:1337`). The *composed* page
 * — chrome + shell, the composition defect surface — is the Vite origin, not the
 * worker origin (the worker serves only the proxied data routes in the dev loop),
 * so that is what the harness renders. Override with `--base` when a build serves
 * the composed surface elsewhere.
 */
export const DEFAULT_LOCAL_BASE = "http://localhost:3000";

/**
 * The dev-override flag cookie honored under `alchemy dev` — same name + wire
 * format as the worker's `apps/web/worker/features/flagship/dev-override.ts`
 * (a URL-encoded JSON `{key: boolean}` map). Seeding it is how flag-gated UI
 * renders locally with no new mechanism (#2946).
 */
export const FLAG_OVERRIDE_COOKIE = "phoenix_flag_overrides";

/**
 * The documented capture budget: the longest edge (in device px) a captured
 * image is kept at or under, so the downstream vision loop stays cost-bounded
 * (vision loops run 10–20x cost unbudgeted, #2943). A shot whose known CSS
 * dimensions exceed this is downscaled (a `deviceScaleFactor` < 1); the crop to
 * the changed region is the other, primary lever.
 */
export const LONGEST_EDGE_BUDGET = 1400;

/** Loopback hostnames a local base is allowed to point at — never a remote host. */
const isLoopbackHost = (host: string): boolean =>
	host === "localhost" ||
	host === "127.0.0.1" ||
	host === "::1" ||
	host === "[::1]" ||
	host.endsWith(".localhost");

/**
 * Resolve + validate the local base URL: default to the Vite dev origin, and
 * refuse anything that isn't an http(s) loopback URL. The refusal is the guard
 * that a *local* render harness never accidentally renders (and seeds a
 * dev-override cookie into) a remote/production origin.
 */
export const resolveLocalBase = (candidate?: string): string => {
	const raw = candidate === undefined || candidate.length === 0 ? DEFAULT_LOCAL_BASE : candidate;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`local-render: base is not a valid absolute URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`local-render: base must be http(s), got ${url.protocol}`);
	}
	if (!isLoopbackHost(url.hostname)) {
		throw new Error(
			`local-render: base must be a loopback host (localhost/127.0.0.1/*.localhost) — refusing to render a non-local origin: ${raw}`,
		);
	}
	return raw;
};

/**
 * Build the dev-override cookie(s) to seed into the capture context, keyed to the
 * local `base`. Returns `[]` for an empty override map (no cookie needed), else a
 * single cookie whose value is the URL-encoded JSON map the worker's
 * `parseOverrideCookie` decodes — the exact wire format of
 * `encodeOverrideCookieValue` in the worker's `dev-override.ts`.
 */
export const buildOverrideCookies = (
	base: string,
	overrides: Readonly<Record<string, boolean>>,
): readonly CaptureCookie[] => {
	const keys = Object.keys(overrides);
	if (keys.length === 0) return [];
	return [
		{
			name: FLAG_OVERRIDE_COOKIE,
			value: encodeURIComponent(JSON.stringify(overrides)),
			url: base,
		},
	];
};

/**
 * Normalize a changed-region clip against the viewport: clamp the origin to the
 * page (x/y ≥ 0), clamp the width to the page width (there is no horizontal
 * scroll), and leave the height unclamped (a full page scrolls vertically, so the
 * region may sit below the fold). Refuses a non-positive or fully-off-page region
 * — an empty clip is a caller bug, not a silent full-page fallback.
 */
export const normalizeClip = (region: CaptureClip, viewport: Viewport): CaptureClip => {
	if (region.width <= 0 || region.height <= 0) {
		throw new Error(
			`local-render: clip region must have positive width/height, got ${region.width}x${region.height}`,
		);
	}
	const x = Math.max(0, region.x);
	const y = Math.max(0, region.y);
	const width = Math.min(region.width, viewport.width - x);
	if (width <= 0) {
		throw new Error(
			`local-render: clip region is off the page width (x=${region.x}, viewport width=${viewport.width})`,
		);
	}
	return {x, y, width, height: region.height};
};

/** The crop + downscale a shot is captured under. `deviceScaleFactor` omitted ⇒ 1x (no downscale). */
export interface CaptureDirective {
	readonly clip?: CaptureClip;
	readonly deviceScaleFactor?: number;
}

/**
 * Compute the crop/downscale directive for one surface under the budget.
 *
 * Crop: when a changed `region` is given, narrow to it (the primary cost lever);
 * else the default full-page shot. Downscale: the raster longest edge is the CSS
 * longest edge × `deviceScaleFactor` (dpr), so to bring it under `budget` we set
 * `deviceScaleFactor = budget / cssLongestEdge`, clamped to ≤ 1 (never upscale).
 * The CSS longest edge is known only for a clipped region (`max(w, h)`) or, for a
 * full-page shot, the viewport width (the page height is dynamic) — so a
 * full-page desktop shot (1280 < 1400) needs no downscale, and the lever kicks in
 * for a wide/tall clipped region.
 */
export const planCaptureDirective = (
	viewport: Viewport,
	opts: {readonly region?: CaptureClip; readonly budget?: number} = {},
): CaptureDirective => {
	const budget = opts.budget ?? LONGEST_EDGE_BUDGET;
	if (budget <= 0) {
		throw new Error(`local-render: budget must be positive, got ${budget}`);
	}
	const clip = opts.region === undefined ? undefined : normalizeClip(opts.region, viewport);
	const cssLongestEdge = clip === undefined ? viewport.width : Math.max(clip.width, clip.height);
	if (cssLongestEdge <= budget) {
		return clip === undefined ? {} : {clip};
	}
	// Round to 4 dp so the factor is stable/reproducible across runs.
	const deviceScaleFactor = Math.round((budget / cssLongestEdge) * 1e4) / 1e4;
	return clip === undefined ? {deviceScaleFactor} : {clip, deviceScaleFactor};
};

/**
 * Parse a `--flag "<key>=on|off"` token into a `[key, boolean]` override entry.
 * `on`/`true`/`1` ⇒ true, `off`/`false`/`0` ⇒ false; anything else is a caller
 * bug (a malformed override is refused, never silently dropped).
 */
export const parseFlagOverride = (token: string): readonly [string, boolean] => {
	const eq = token.indexOf("=");
	if (eq <= 0) {
		throw new Error(`local-render: --flag must be "<key>=on|off", got: ${token}`);
	}
	const key = token.slice(0, eq).trim();
	const raw = token
		.slice(eq + 1)
		.trim()
		.toLowerCase();
	if (key.length === 0) {
		throw new Error(`local-render: --flag has an empty key: ${token}`);
	}
	if (raw === "on" || raw === "true" || raw === "1") return [key, true];
	if (raw === "off" || raw === "false" || raw === "0") return [key, false];
	throw new Error(`local-render: --flag value must be on/off, got: ${token}`);
};

/**
 * Parse a `--region "<surface>=x,y,w,h"` token into a `[surface, clip]` entry —
 * the changed-region crop for one surface. The four comma-separated numbers are
 * CSS px; a malformed spec is refused.
 */
export const parseRegionSpec = (token: string): readonly [string, CaptureClip] => {
	const eq = token.indexOf("=");
	if (eq <= 0) {
		throw new Error(`local-render: --region must be "<surface>=x,y,w,h", got: ${token}`);
	}
	const surface = token.slice(0, eq).trim();
	if (surface.length === 0) {
		throw new Error(`local-render: --region has an empty surface: ${token}`);
	}
	const parts = token
		.slice(eq + 1)
		.split(",")
		.map((p) => Number(p.trim()));
	if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
		throw new Error(`local-render: --region rect must be four numbers "x,y,w,h", got: ${token}`);
	}
	const [x, y, width, height] = parts as [number, number, number, number];
	return [surface, {x, y, width, height}];
};

/** Options for {@link buildLocalShots}: viewport, budget, and per-surface changed regions. */
export interface LocalShotOptions {
	readonly viewport?: Viewport;
	readonly budget?: number;
	/** Changed-region clips keyed by the surface token (`--surface`); a surface with no entry is shot full-page. */
	readonly regions?: Readonly<Record<string, CaptureClip>>;
}

/**
 * Build the local capture plan: reuse `@kampus/design-capture`'s `buildCapturePlan`
 * (URL join, filesystem-safe name, empty/duplicate guards) over the local `base`,
 * then attach each surface's crop/downscale directive. One {@link Shot} per surface.
 */
export const buildLocalShots = (
	base: string,
	surfaces: readonly Surface[],
	opts: LocalShotOptions = {},
): readonly Shot[] => {
	const viewport = opts.viewport ?? DEFAULT_VIEWPORT;
	const plan = buildCapturePlan(base, surfaces, viewport);
	const regions = opts.regions ?? {};
	return plan.map((shot) => {
		const region = regions[shot.surface.surface];
		const directive = planCaptureDirective(viewport, {
			...(region === undefined ? {} : {region}),
			...(opts.budget === undefined ? {} : {budget: opts.budget}),
		});
		return {...shot, ...directive};
	});
};
