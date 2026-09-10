/**
 * The pure priority-surface core: the small, ORDERED set of surfaces the
 * candidate-render step shoots for the one blessing session — the global shell +
 * product subnav, then a parameterized term page, then a feed. The order is
 * load-bearing: the blessing gallery is presented in it, so the list is ordered data,
 * never an incidental array.
 *
 * A surface's identity is the `<route>[:state]` capture spec keyed exactly the way
 * the golden pointer is (`surface-id -> { sha256, blessed-date, intent }`), so a
 * blessed candidate's surface-id IS the pointer key — no second
 * identity scheme. Route and state are carried as SEPARATE fields (not one
 * colon-joined string) because a route TEMPLATE also uses `:` for params
 * (`/sozluk/:slug`); keeping them apart makes param substitution unambiguous, and the
 * concrete surface-id is assembled only after the term slug is filled (a template
 * can't be captured — a real term must be named).
 *
 * Pure + IO-free: this is the unit-tested selection logic; the impure capture/store
 * legs run over the surfaces it resolves (see `candidate-render.ts`).
 */
import {parseSurfaceSpec, type Surface} from "./plan.ts";

/** A stable key for one priority surface — the three deliberate screens. */
export type PrioritySurfaceKey = "global-shell-subnav" | "sozluk-term" | "pano-feed";

/** One priority surface: its rank, its route (+ optional state), its bless intent. */
export interface PrioritySurfaceSpec {
	/** 1-based rank in the blessing order. */
	readonly order: number;
	readonly key: PrioritySurfaceKey;
	/** Human label shown in the blessing gallery. */
	readonly title: string;
	/**
	 * The route path, possibly a template with `:param` segments (e.g.
	 * `/sozluk/:slug`) the resolve step fills with concrete data. Never carries a
	 * `:state` suffix — state is the separate field below.
	 */
	readonly route: string;
	/** The capture state variant (`empty`, `focus-visible`, …), or omitted for the default render. */
	readonly state?: string;
	/** The bless intent recorded on the golden pointer — what this golden captures / why. */
	readonly intent: string;
}

/**
 * The priority set, in blessing order. The first route is the shell + product-subnav
 * chrome reference — the composition a recurring shell/subnav defect class kept getting
 * wrong; the second is the term page; the third is the feed. The intents carry the
 * taste each golden is judged against.
 */
export const PRIORITY_SURFACES: readonly PrioritySurfaceSpec[] = [
	{
		order: 1,
		key: "global-shell-subnav",
		title: "Global shell + product subnav",
		route: "/sozluk",
		intent:
			"Global app shell + product subnav chrome — the composition reference the shell/subnav defect class must converge to.",
	},
	{
		order: 2,
		key: "sozluk-term",
		title: "Term page",
		route: "/sozluk/:slug",
		intent: "Term page — the single-entry reading surface, in a modern, a11y body.",
	},
	{
		order: 3,
		key: "pano-feed",
		title: "Feed",
		route: "/pano",
		intent: "Feed — the link-aggregator feed composition reference.",
	},
];

/** A resolved priority surface: the concrete capture Surface + its order/title/intent. */
export interface ResolvedPrioritySurface {
	readonly order: number;
	readonly key: PrioritySurfaceKey;
	readonly title: string;
	readonly intent: string;
	/** The concrete surface (route + optional state), route params substituted. */
	readonly surface: Surface;
}

/** The concrete data a priority surface's route template needs (e.g. the term slug). */
export interface PrioritySurfaceParams {
	/** The seeded term slug substituted into `/sozluk/:slug` — a real term on the preview. */
	readonly termSlug: string;
}

const PARAM_SEGMENT = /^:([A-Za-z][A-Za-z0-9_]*)$/;

/**
 * Substitute `:param` path segments in a ROUTE template from a params map. Operates
 * on the route only (state is separate), so no colon ambiguity. Fails closed on an
 * unfilled param — a `/sozluk/:slug` left with a live `:slug` would capture a 404,
 * so an absent param is a caller bug, never a silent bad shot.
 */
export const substituteRouteParams = (
	route: string,
	params: Readonly<Record<string, string>>,
): string =>
	route
		.split("/")
		.map((segment) => {
			const match = PARAM_SEGMENT.exec(segment);
			if (match === null) return segment;
			const name = match[1] as string;
			const value = params[name];
			if (value === undefined || value.length === 0) {
				throw new Error(
					`priority-surfaces: route param ":${name}" in "${route}" has no value — cannot render an unfilled route`,
				);
			}
			return encodeURIComponent(value);
		})
		.join("/");

/**
 * Resolve the priority set into concrete capture surfaces, in rank order.
 * Substitutes each route's params (the term slug), assembles the `<route>[:state]`
 * surface-id, parses it into a {@link Surface}, and asserts the set is well-formed:
 * contiguous 1-based order and unique surface-ids (a duplicate would collide two
 * candidates onto one pointer key). Fail-closed — an ill-formed priority set is a
 * bug, not a partial set.
 */
export const resolvePrioritySurfaces = (
	params: PrioritySurfaceParams,
	specs: readonly PrioritySurfaceSpec[] = PRIORITY_SURFACES,
): readonly ResolvedPrioritySurface[] => {
	if (specs.length === 0) {
		throw new Error("priority-surfaces: empty priority set — nothing to render");
	}
	const ordered = [...specs].sort((a, b) => a.order - b.order);
	ordered.forEach((spec, index) => {
		if (spec.order !== index + 1) {
			throw new Error(
				`priority-surfaces: order must be contiguous 1..${ordered.length}; got ${spec.order} at rank ${index + 1}`,
			);
		}
	});
	// The term route names its param `:slug`; the priority-surface params supply
	// it as `termSlug` (the one concrete datum the priority set needs).
	const routeParams = {slug: params.termSlug};
	const seen = new Set<string>();
	return ordered.map((spec) => {
		const route = substituteRouteParams(spec.route, routeParams);
		const surfaceId = spec.state === undefined ? route : `${route}:${spec.state}`;
		if (seen.has(surfaceId)) {
			throw new Error(
				`priority-surfaces: duplicate surface-id ${surfaceId} — surfaces must be unique`,
			);
		}
		seen.add(surfaceId);
		return {
			order: spec.order,
			key: spec.key,
			title: spec.title,
			intent: spec.intent,
			surface: parseSurfaceSpec(surfaceId),
		};
	});
};
