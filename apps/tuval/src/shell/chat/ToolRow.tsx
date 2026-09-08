/**
 * One tool call, collapsed to a line and expandable to its input and its result.
 *
 * The disclosure is `Collapsible` from `@kampus/design`, which is Zag-driven: it wires the
 * trigger's `aria-expanded` and `aria-controls` itself, and the name comes from the trigger's own
 * content (`.patterns/manti-accessibility.md`). So the trigger carries the tool's name and its
 * status as *words* — the status colour is decoration, never the only signal (ADR 0162, Pillar 4).
 *
 * Open/closed is **controlled** rather than the primitive's own uncontrolled state, because the
 * fact lives in the window's `view` slot: two windows over one process open the same call
 * independently, and a window switched away from and back to comes back opened the way it was left.
 *
 * A group head carries a **second, separate** disclosure for the subagent rows folded under it. The
 * two cannot share one control: `Collapsible` wires `aria-expanded`/`aria-controls` over the content
 * it owns, and the folded rows are siblings in the virtualized list outside that content, so a
 * shared trigger announces the input panel while N unrelated rows appear unannounced (#8027, ADR
 * 0162 Pillar 4). The fold button states the act it performs in its own text, so reading the call's
 * input no longer bursts the group open as a side effect.
 *
 * That button carries `aria-expanded` and deliberately no `aria-controls`: the rows it reveals are
 * virtualized, so an idref list names ids the document does not hold, and the APG disclosure pattern
 * treats the attribute as optional (#8057).
 */

import {Button, Collapsible} from "@kampus/design";
import type {ReactElement} from "react";
import type {ToolItem} from "../../ai-agent/ports/index.ts";
import {ToolCallDetail} from "./ToolCallDetail.tsx";
import {callDisclosure} from "./tool-detail.ts";

/**
 * The fold button's own text, which is also its accessible name. It names the act rather than the
 * state, because the button is the only thing that says these rows exist at all.
 */
const foldLine = (count: number, open: boolean): string =>
	`${open ? "Hide" : "Show"} ${count} nested ${count === 1 ? "call" : "calls"}`;

/** A group head's fold, absent on a row that heads no group — so a count without rows cannot exist. */
export interface ToolFold {
	/** How many rows this fold reveals — the button counts them rather than naming them. */
	readonly count: number;
	readonly open: boolean;
	readonly onToggle: (open: boolean) => void;
}

export function ToolRow({
	item,
	expanded,
	fold,
	onToggle,
}: {
	readonly item: ToolItem;
	readonly expanded: boolean;
	/** The subagent rows folded under this one, or `null` on a row that heads no group. */
	readonly fold: ToolFold | null;
	readonly onToggle: (open: boolean) => void;
}): ReactElement {
	// The trigger shows the tool's name and nothing else, so that is the whole of what the detail
	// below is deduped against.
	const disclosure = callDisclosure(item, item.name);
	return (
		<>
			<Collapsible
				className="tuval-chat-tool"
				open={expanded}
				onOpenChange={onToggle}
				trigger={
					<span className="tuval-chat-tool-head">
						<span className="tuval-chat-tool-name">{item.name}</span>
						<span className="tuval-chat-tool-status" data-status={item.status}>
							{item.status}
						</span>
					</span>
				}
			>
				<ToolCallDetail disclosure={disclosure} />
			</Collapsible>
			{fold === null ? null : (
				<Button
					type="button"
					variant="tertiary"
					size="sm"
					className="tuval-chat-tool-fold"
					aria-expanded={fold.open}
					onClick={() => fold.onToggle(!fold.open)}
				>
					{foldLine(fold.count, fold.open)}
				</Button>
			)}
		</>
	);
}
