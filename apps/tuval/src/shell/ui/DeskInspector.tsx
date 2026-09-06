/**
 * The desk inspector: one region beside the tiling area, filled by the focused window's program.
 *
 * It is mounted or not mounted — never a collapsed shell with its own disclosure — because the
 * open/closed flag is desk state the kernel holds (`../desk/state.ts`) and `desk:inspector-toggle`
 * is the one thing that writes it. A `Collapsible` here would be a second authority over the same
 * bit, and its trigger would still be on screen with the region closed.
 *
 * Every `NoInspector` reason gets a sentence rather than a hole (#7500 rulings 4 and 5): the walk
 * that ends in one is a value, and the reader is told which step ended. A renderer that *throws* is
 * a different failure and gets the boundary — sized to this region alone, so a program's bad
 * inspector costs the founder the panel and not the windows.
 */

import {Card, EmptyState} from "@kampus/design";
import type {ReactElement, ReactNode} from "react";
import type {DeskEmptyReason, InspectorRegion} from "../desk/index.ts";
import "./desk.css";
import {ErrorBoundary} from "./ErrorBoundary.tsx";

/**
 * Why the region is empty, in the reader's words. Every arm of `DeskEmptyReason` is here and the
 * record is total, so a new arm is a compile error rather than a blank panel.
 */
const emptyReason: Readonly<Record<DeskEmptyReason, string>> = {
	"no-focused-window": "No window has focus. Focus one and its program fills this region.",
	"window-unbound": "The focused window is showing no process.",
	"process-unknown": "The focused window's process has left the table.",
	"program-unknown": "This page holds no program row for that process.",
	"not-declared": "This program declares no inspector.",
	"unknown-ref": "This page answers to no inspector by the name that program declares.",
	"kind-mismatch": "That program's inspector is declared at a kind this page does not mount.",
	"module-load-failed": "This page could not load the module that program's inspector names.",
};

/**
 * The program's renderer, run inside its own component. Called in the parent's body it would throw
 * during the *parent's* render, above the boundary and past it — the panel has to be the thing that
 * throws for the boundary to be the thing that catches.
 */
const Mounted = ({
	region,
}: {
	readonly region: Extract<InspectorRegion, {readonly _tag: "Inspector"}>;
}): ReactElement => <>{region.renderer.render(region.host) as ReactNode}</>;

export interface DeskInspectorProps {
	readonly region: InspectorRegion;
	/**
	 * What a caught throw is cleared by. Values, never objects: the boundary compares its keys with
	 * `Object.is` and every snapshot arrives decoded afresh (`./ErrorBoundary.tsx`).
	 */
	readonly resetKeys?: ReadonlyArray<unknown>;
}

export function DeskInspector({region, resetKeys = []}: DeskInspectorProps): ReactElement {
	return (
		<Card
			as="section"
			className="tuval-inspector"
			aria-label="Desk inspector"
			// The panel is its own scroll container, and a scroll container a keyboard user cannot
			// reach is content they cannot read. It sits after the tiling area in the DOM, so Tab
			// lands here on the way out of the windows.
			tabIndex={0}
		>
			<h2 className="tuval-inspector-title">Inspector</h2>
			{region._tag === "NoInspector" ? (
				// Centred in what is left of a full-height column rather than sitting under the title:
				// a sparse region reads as composed, never as a void with its content jammed at the top
				// (`design-system-manifest.md`, Pillar 3).
				<div className="tuval-inspector-empty">
					<EmptyState title="Nothing to inspect" description={emptyReason[region.reason]} />
				</div>
			) : (
				<ErrorBoundary
					label="The desk inspector"
					className="tuval-inspector-panel"
					resetKeys={resetKeys}
				>
					<Mounted region={region} />
				</ErrorBoundary>
			)}
		</Card>
	);
}
