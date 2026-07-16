/**
 * The exhibit contract — one curated entry in atölye: a component + its knob schema +
 * the fixed props knobs don't drive, plus the catalog metadata the index lists by.
 *
 * `defineExhibit` is the seam every exhibit module authors against: it captures the
 * component's props `P` so the knob schema is type-checked against real props at the
 * declaration site, then erases to `AnyExhibit` so heterogeneous exhibits (each with a
 * different `P`) live in one registry array — the existential-type boundary.
 */

import type * as React from "react";
import type {AnyKnobSchema, KnobSchema} from "./knob";

export interface Exhibit<P> {
	/** Stable kebab-case slug — the URL segment and the registry key; unique across the registry. */
	readonly id: string;
	/** Turkish display name shown in the index and as the detail heading. */
	readonly title: string;
	/** One-line Turkish thesis — the curation note stating why this piece earns an exhibit. */
	readonly summary?: string;
	readonly component: React.ComponentType<P>;
	readonly knobs: KnobSchema<P>;
	/** Props supplied to every render but not exposed as knobs (children, non-knobbable props). */
	readonly fixedProps?: Partial<P>;
}

/** The type-erased exhibit the registry stores and the routes/tests enumerate. */
export interface AnyExhibit {
	readonly id: string;
	readonly title: string;
	readonly summary?: string;
	readonly component: React.ComponentType<Record<string, unknown>>;
	readonly knobs: AnyKnobSchema;
	readonly fixedProps?: Record<string, unknown>;
}

export function defineExhibit<P>(exhibit: Exhibit<P>): AnyExhibit {
	// The existential-type boundary: `P` is checked at the declaration site above, then the
	// entry is widened to the props-erased `AnyExhibit` the registry stores. Each field is a
	// single narrowing cast — no double-cast laundering.
	return {
		id: exhibit.id,
		title: exhibit.title,
		summary: exhibit.summary,
		component: exhibit.component as React.ComponentType<Record<string, unknown>>,
		knobs: exhibit.knobs as AnyKnobSchema,
		fixedProps: exhibit.fixedProps as Record<string, unknown> | undefined,
	};
}
