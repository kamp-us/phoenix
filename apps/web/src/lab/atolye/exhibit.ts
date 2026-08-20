// The exhibit contract and `defineExhibit`. See .patterns/atolye-exhibit-harness.md

import type * as React from "react";
import type {AnyKnobSchema, KnobSchema} from "./knob";

export interface Exhibit<P> {
	readonly id: string;
	/** The component's real (English, technical) name shown in the index and as the detail heading. */
	readonly title: string;
	readonly summary?: string;
	readonly component: React.ComponentType<P>;
	readonly knobs: KnobSchema<P>;
	readonly fixedProps?: Partial<P>;
}

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
