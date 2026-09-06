/**
 * Resolving a surface id onto the declared app that serves it, and onto that app's own URL.
 *
 * The declaration itself is the `uiSurfaces` key (`../config/keys/ui-surfaces.ts`); this module is
 * the arithmetic over it. A repo has more than one runnable app (phoenix has two under ADR 0345), so
 * a surface resolves to the app whose `mount` is its longest match, never onto one shared base URL.
 * Readiness is per app, so a surface served by a worker-free app goes green the moment that app
 * answers.
 */

import type {UiSurface} from "../config/keys/ui-surfaces.ts";

/** The readiness bound: an app that has not answered 200 by here leaves its surfaces UNKNOWN. */
export const READY_TIMEOUT_MS = 60_000;

/** A mount claims a surface on segment boundaries: `/lab` owns `/lab/x`, never `/laboratory`. */
const claims = (mount: string, surface: string): boolean =>
	mount === "/" || surface === mount || surface.startsWith(`${mount}/`);

/** The app serving a surface: the longest claiming mount, or `null` when the namespace has a hole. */
export const appForSurface = (
	surfaces: ReadonlyArray<UiSurface>,
	surface: string,
): UiSurface | null =>
	surfaces
		.filter((app) => claims(app.mount, surface))
		.reduce<UiSurface | null>(
			(best, app) => (best === null || app.mount.length > best.mount.length ? app : best),
			null,
		);

/**
 * The path a surface has on its own app's server: the surface with its mount replaced by the app's
 * `basePath`. `basePath` defaults to the mount, which makes the default an identity — a mount is a
 * namespace, and only an app serving those pages at a different root (a proof server rooted at `/`)
 * has to say so.
 */
export const surfacePath = (app: UiSurface, surface: string): string => {
	const remainder = app.mount === "/" ? surface : surface.slice(app.mount.length);
	const joined = `${app.basePath ?? app.mount}${remainder}`.replace(/\/{2,}/g, "/");
	return joined === "" ? "/" : joined;
};

/** The URL to navigate for a surface, given the origin its app was started on. */
export const surfaceUrl = (origin: string, app: UiSurface, surface: string): string =>
	`${origin.replace(/\/+$/, "")}${surfacePath(app, surface)}`;

/** `/` → `root`; every other route becomes its slug (`/pano/yeni` → `pano-yeni`). */
export const surfaceSlug = (route: string): string => {
	const trimmed = route.replace(/^\/+/, "").replace(/\/+$/, "");
	return trimmed === "" ? "root" : trimmed.replace(/\//g, "-");
};
