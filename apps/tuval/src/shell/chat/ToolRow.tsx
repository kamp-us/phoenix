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
import {omissionLine, type ToolDetail, toolDetail} from "./tool-detail.ts";

function DetailView({detail}: {readonly detail: ToolDetail}): ReactElement {
	if (detail.kind === "edit") {
		return (
			<div className="tuval-chat-tool-detail">
				<p className="tuval-chat-tool-label">edit · {detail.path}</p>
				{/*
				 * A `table` rather than a list: each row is a line and a marker, and the marker is a
				 * real cell rather than a `::before` glyph, so a screen reader reads "removed" instead
				 * of nothing at all. The caption names the table for the same reason.
				 */}
				<table className="tuval-chat-diff">
					<caption className="kp-visually-hidden">Changes to {detail.path}</caption>
					<tbody>
						{detail.diff.map((line, index) => (
							<tr
								// A diff line has no identity of its own — two identical lines are two rows
								// of the same text — so the index is the only stable key there is, and the
								// list is rebuilt whole whenever the item changes.
								key={`${index}:${line.kind}:${line.text}`}
								data-line={line.kind}
							>
								{/*
								 * The marker is the word itself, not a `+`/`-` glyph: the change is
								 * carried by text for everyone, and the row tint is the second signal
								 * rather than the only one (ADR 0162, Pillar 4). An unchanged line says
								 * so only to assistive tech, because a column of "unchanged" beside every
								 * context line is noise on screen.
								 */}
								<th scope="row" className="tuval-chat-diff-kind">
									<span className={line.kind === "same" ? "kp-visually-hidden" : undefined}>
										{line.kind === "same" ? "unchanged" : line.kind}
									</span>
								</th>
								<td className="tuval-chat-diff-text">{line.text}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		);
	}
	if (detail.kind === "shell") {
		return (
			<div className="tuval-chat-tool-detail">
				<p className="tuval-chat-tool-label">command</p>
				<pre className="tuval-chat-pre">{detail.command}</pre>
			</div>
		);
	}
	return (
		<div className="tuval-chat-tool-detail">
			<p className="tuval-chat-tool-label">input</p>
			<pre className="tuval-chat-pre">{detail.input}</pre>
		</div>
	);
}

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
	const detail = toolDetail(item);
	const omitted = omissionLine(item.result.omitted.bytes);
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
				<DetailView detail={detail} />
				<div className="tuval-chat-tool-detail">
					<p className="tuval-chat-tool-label">{detail.kind === "shell" ? "output" : "result"}</p>
					<pre className="tuval-chat-pre">{item.result.text}</pre>
					{omitted === null ? null : <p className="tuval-chat-omission">{omitted}</p>}
				</div>
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
