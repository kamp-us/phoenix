/**
 * The pure capture-plan core: turn a preview-deploy base URL + the changed UI
 * surfaces + the deterministic viewports into the flat list of screenshots to
 * shoot. No browser, no network — this is the unit-tested selection logic the
 * review-design gate (ADR 0165) reasons about; `capture.ts` drives Playwright
 * over the plan this produces.
 */

/** A changed UI surface to shoot: a stable id + the route to visit on the preview. */
export interface Surface {
	/** Filename-/attachment-safe stable id, e.g. `sozluk-home`. Must be unique in a request. */
	readonly label: string;
	/** Path on the preview deploy, e.g. `/sozluk` or `/pano/abc123`. */
	readonly route: string;
}

/** A deterministic viewport the gate judges at (fixed sizes ⇒ reproducible shots). */
export interface Viewport {
	readonly label: string;
	readonly width: number;
	readonly height: number;
}

/**
 * The two viewports review-design judges the four-pillars law at (ADR 0162): a
 * desktop column and a phone column. Mobile is load-bearing for the pillar
 * prohibitions that are size-relative — a sub-36px tap-target and cramped
 * off-grid spacing only show up at the narrow width. Fixed (not device-emulated)
 * so a shot is byte-reproducible for the same head.
 */
export const DESKTOP_VIEWPORT: Viewport = {label: "desktop", width: 1280, height: 800};
export const MOBILE_VIEWPORT: Viewport = {label: "mobile", width: 390, height: 844};
export const DEFAULT_VIEWPORTS: readonly Viewport[] = [DESKTOP_VIEWPORT, MOBILE_VIEWPORT];

/** One screenshot to take: an absolute URL at a viewport, under a unique label. */
export interface Shot {
	/** `${surface.label}@${viewport.label}` — unique across the plan. */
	readonly label: string;
	/** Absolute URL: the preview base joined with the surface route. */
	readonly url: string;
	readonly viewport: Viewport;
}

/**
 * Join a preview-deploy base with a surface route into one absolute URL. Trailing
 * slashes on the base and a leading-slash-optional route are normalized so
 * `join("https://x.dev/", "sozluk")` and `join("https://x.dev", "/sozluk")` both
 * yield `https://x.dev/sozluk`. The base must be an absolute http(s) URL — the
 * per-PR preview URL the `preview-deploy` bot comment posts.
 */
export const joinPreviewUrl = (previewUrl: string, route: string): string => {
	let base: URL;
	try {
		base = new URL(previewUrl);
	} catch {
		throw new Error(`review-capture: preview URL is not a valid absolute URL: ${previewUrl}`);
	}
	if (base.protocol !== "http:" && base.protocol !== "https:") {
		throw new Error(`review-capture: preview URL must be http(s), got ${base.protocol}`);
	}
	// Resolve the route against the base origin+path — `new URL(route, base)` handles
	// both an absolute path (`/sozluk`) and a bare segment, and strips the redundant slash.
	const path = route.startsWith("/") ? route : `/${route}`;
	return new URL(path, base).toString();
};

/**
 * Build the flat capture plan: the cross-product of surfaces × viewports, one
 * `Shot` each. Fails closed on an empty surface set (nothing to shoot is a caller
 * bug, not a silent no-op) and on duplicate surface labels (two shots would
 * collide on the same attachment name). The `label` is the join of the surface
 * and viewport labels so every shot in the plan is uniquely addressable.
 */
export const buildCapturePlan = (
	previewUrl: string,
	surfaces: readonly Surface[],
	viewports: readonly Viewport[] = DEFAULT_VIEWPORTS,
): readonly Shot[] => {
	if (surfaces.length === 0) {
		throw new Error("review-capture: no surfaces to capture — refusing to build an empty plan");
	}
	if (viewports.length === 0) {
		throw new Error("review-capture: no viewports to capture — refusing to build an empty plan");
	}
	const seen = new Set<string>();
	for (const s of surfaces) {
		if (s.label.length === 0) {
			throw new Error("review-capture: a surface has an empty label");
		}
		if (seen.has(s.label)) {
			throw new Error(`review-capture: duplicate surface label ${s.label} — labels must be unique`);
		}
		seen.add(s.label);
	}
	return surfaces.flatMap((surface) =>
		viewports.map((viewport) => ({
			label: `${surface.label}@${viewport.label}`,
			url: joinPreviewUrl(previewUrl, surface.route),
			viewport,
		})),
	);
};
