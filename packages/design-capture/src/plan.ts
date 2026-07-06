/**
 * The pure capture-plan core: parse the review-design skill's `--surface`
 * tokens, and turn a preview-deploy base URL + the changed surfaces into the
 * flat list of screenshots to shoot. No browser, no network — this is the
 * unit-tested selection logic the review-design gate (ADR 0165) reasons about;
 * `capture.ts` drives Playwright over the plan this produces.
 *
 * One record per surface (the contract #2246 codes against), NOT a viewport
 * cross-product: a surface is a route + an optional state variant
 * (`empty`, `focus-visible`, …), captured at a single viewport.
 */

/** A changed UI surface to shoot: a route + an optional state variant. */
export interface Surface {
	/** The raw `--surface` token (`/sozluk` or `/sozluk:empty`) — a stable id. */
	readonly surface: string;
	/** The route/path on the preview deploy, e.g. `/sozluk`. */
	readonly route: string;
	/** The state variant (`empty`, `focus-visible`, …) or `null` for the default render. */
	readonly state: string | null;
}

/**
 * Parse a `--surface "<route>[:state]"` token into a {@link Surface}. The first
 * colon splits route from state (a route is a URL path and carries no colon), so
 * `/sozluk:empty` → route `/sozluk`, state `empty`; `/sozluk` → state `null`.
 */
export const parseSurfaceSpec = (token: string): Surface => {
	if (token.length === 0) {
		throw new Error("design-capture: empty --surface token");
	}
	const colon = token.indexOf(":");
	const route = colon === -1 ? token : token.slice(0, colon);
	const rawState = colon === -1 ? "" : token.slice(colon + 1);
	if (route.length === 0) {
		throw new Error(`design-capture: --surface token has no route: ${token}`);
	}
	return {surface: token, route, state: rawState.length === 0 ? null : rawState};
};

/** A deterministic viewport the capture runs at (fixed size ⇒ reproducible shots). */
export interface Viewport {
	readonly label: string;
	readonly width: number;
	readonly height: number;
}

/**
 * The viewports review-design can judge the four-pillars law at (ADR 0162).
 * Desktop is the default single capture viewport; mobile is available for the
 * size-relative prohibitions (a sub-36px tap target, cramped off-grid spacing)
 * when the caller opts into it. Fixed (not device-emulated) so a shot is
 * byte-reproducible for the same head.
 */
export const DESKTOP_VIEWPORT: Viewport = {label: "desktop", width: 1280, height: 800};
export const MOBILE_VIEWPORT: Viewport = {label: "mobile", width: 390, height: 844};
export const DEFAULT_VIEWPORT: Viewport = DESKTOP_VIEWPORT;

/** One screenshot to take: an absolute URL at a viewport, written to `fileName`. */
export interface Shot {
	readonly surface: Surface;
	/** Absolute URL: the preview base joined with the surface route. */
	readonly url: string;
	readonly viewport: Viewport;
	/** Filesystem-safe PNG file name (written under the capture out-dir). */
	readonly fileName: string;
}

/**
 * Join a preview-deploy base with a surface route into one absolute URL. Trailing
 * slashes on the base and a leading-slash-optional route are normalized. The base
 * must be an absolute http(s) URL — the per-PR preview URL the `preview-deploy`
 * bot comment posts.
 */
export const joinPreviewUrl = (previewUrl: string, route: string): string => {
	let base: URL;
	try {
		base = new URL(previewUrl);
	} catch {
		throw new Error(`design-capture: preview URL is not a valid absolute URL: ${previewUrl}`);
	}
	if (base.protocol !== "http:" && base.protocol !== "https:") {
		throw new Error(`design-capture: preview URL must be http(s), got ${base.protocol}`);
	}
	const path = route.startsWith("/") ? route : `/${route}`;
	return new URL(path, base).toString();
};

/**
 * A filesystem-safe PNG file name derived from a surface's route + state.
 *
 * The surface route is caller-supplied (uncontrolled), so the sanitization must
 * run in linear time on any input: an unbounded run of non-alnum characters
 * would let an anchored trailing-dash trim (`/^-+|-+$/g`) backtrack
 * polynomially — the ReDoS CodeQL flagged (alert #24). So the route is clamped
 * to a bounded length before sanitizing (a filename never needs to be longer),
 * and the leading/trailing-dash trim is a single-pass index walk, not a
 * backtracking regex.
 */
const MAX_FILENAME_STEM = 128;
export const surfaceFileName = (surface: Surface, viewport: Viewport): string => {
	const base = surface.state === null ? surface.route : `${surface.route}-${surface.state}`;
	const clamped = base.length > MAX_FILENAME_STEM ? base.slice(0, MAX_FILENAME_STEM) : base;
	// `[^…]+` over a negated class is a single greedy quantifier — linear, no
	// backtracking. The dash-trim that WAS polynomial is now the index walk below.
	const collapsed = clamped.replace(/^\//, "").replace(/[^a-zA-Z0-9._-]+/g, "-");
	let start = 0;
	let end = collapsed.length;
	while (start < end && collapsed[start] === "-") start++;
	while (end > start && collapsed[end - 1] === "-") end--;
	const safe = collapsed.slice(start, end);
	return `${safe.length === 0 ? "root" : safe}@${viewport.label}.png`;
};

/**
 * Build the capture plan: one {@link Shot} per surface (at the given viewport).
 * Fails closed on an empty surface set (nothing to shoot is a caller bug, not a
 * silent no-op) and on duplicate surface tokens (two shots would collide on the
 * same on-disk name and evidence).
 */
export const buildCapturePlan = (
	previewUrl: string,
	surfaces: readonly Surface[],
	viewport: Viewport = DEFAULT_VIEWPORT,
): readonly Shot[] => {
	if (surfaces.length === 0) {
		throw new Error("design-capture: no surfaces to capture — refusing to build an empty plan");
	}
	const seen = new Set<string>();
	for (const s of surfaces) {
		if (seen.has(s.surface)) {
			throw new Error(`design-capture: duplicate surface ${s.surface} — surfaces must be unique`);
		}
		seen.add(s.surface);
	}
	return surfaces.map((surface) => ({
		surface,
		url: joinPreviewUrl(previewUrl, surface.route),
		viewport,
		fileName: surfaceFileName(surface, viewport),
	}));
};
