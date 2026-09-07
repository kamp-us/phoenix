/**
 * The subagent navigator at the top of the agent window (#8405, #8406).
 *
 * Rendered off the port's subagent slot alone, so every agent program gets it the moment its
 * mapper fills the slot — nothing here names a backend. Absent rather than empty when nothing is
 * running and the window is on main (Q4, the founder: "my screen should only show me enough info,
 * not more"), which is why this returns `null` instead of an empty region.
 *
 * It is a navigator and not a readout (Q8): each row is a real button that swaps the window's one
 * view slot onto that worker's transcript, and inside a subagent view a leading row swaps back to
 * the agent's own. Both reach with mouse and keyboard alike, which was Q4's other half.
 *
 * Elapsed is the one thing the list computes rather than reads. It ticks on a timer that moves a
 * render counter and nothing else: a per-second `Msg` would checkpoint the whole session once a
 * second per running worker, and a per-second view write would do the same to this window's slot.
 */

import {MetaRow} from "@kampus/design";
import type {ReactElement} from "react";
import {useEffect, useMemo, useState} from "react";
import type {SubagentSlot} from "../../ai-agent/ports/index.ts";
import {elapsedLabel, runningSubagents, type SubagentRow, tokenLabel} from "./subagents.ts";

/** How often the elapsed readouts are re-rendered. One second: the coarsest unit the label shows. */
const TICK_MS = 1_000;

function NavigatorRow({
	row,
	at,
	onView,
}: {
	readonly row: SubagentRow;
	readonly at: number;
	readonly onView: (id: string) => void;
}): ReactElement {
	return (
		<li className="tuval-chat-subagent-item">
			<button
				type="button"
				className="tuval-chat-subagent-pick"
				// The row that is showing is marked rather than disabled: a disabled control drops out
				// of the tab order, so the operator's place in the navigator would vanish under them.
				aria-current={row.current ? "true" : undefined}
				onClick={() => onView(row.id)}
			>
				<MetaRow as="span" className="tuval-chat-subagent">
					<span className="tuval-chat-subagent-type" data-field="type">
						{row.type}
					</span>
					<MetaRow.Dot />
					<span className="tuval-chat-subagent-line" data-field="line">
						{row.lastLine}
					</span>
					{row.status === "finished" ? (
						<>
							<MetaRow.Dot />
							{/* Q2: no elapsed and no token readout once a worker stops. */}
							<span data-field="status">finished</span>
						</>
					) : (
						<>
							<MetaRow.Dot />
							<span data-field="elapsed">
								{/* The unit is what the number means, and the layout is the only thing saying it. */}
								<span className="kp-visually-hidden">elapsed </span>
								{elapsedLabel(at - row.startedAt)}
							</span>
							<MetaRow.Dot />
							<span data-field="tokens">
								{tokenLabel(row.tokens)}
								<span className="kp-visually-hidden"> tokens</span>
							</span>
						</>
					)}
				</MetaRow>
			</button>
		</li>
	);
}

export function SubagentList({
	slots,
	now,
	viewing,
	onView,
	onMain,
}: {
	readonly slots: Readonly<Record<string, SubagentSlot>>;
	readonly now: () => number;
	/** The subagent whose transcript the window is showing, or `null` for the agent's own. */
	readonly viewing: string | null;
	readonly onView: (id: string) => void;
	readonly onMain: () => void;
}): ReactElement | null {
	const model = useMemo(() => runningSubagents(slots, viewing), [slots, viewing]);
	const running = model.rows.filter((row) => row.status === "running").length;

	// The counter's value is never read: setting it is the re-render, and the re-render is the tick.
	const [, tick] = useState(0);
	useEffect(() => {
		if (running === 0) return;
		const timer = setInterval(() => tick((count) => count + 1), TICK_MS);
		return () => clearInterval(timer);
	}, [running]);

	// A subagent view always draws the region, even with nothing to list: the way back is in it, and
	// a slot that has gone from state must not take the operator's exit with it.
	if (model.rows.length === 0 && viewing === null) return null;
	const at = now();
	return (
		<ul
			className="tuval-chat-subagents"
			// On main the region is what it says: the workers running right now. In a subagent view it
			// also carries the way back and, under Q9, a worker that has stopped — so it is named for
			// what it is there instead.
			aria-label={viewing === null ? "Running subagents" : "Subagents"}
		>
			{viewing === null ? null : (
				<li className="tuval-chat-subagent-item">
					<button type="button" className="tuval-chat-subagent-pick" onClick={onMain}>
						<MetaRow as="span" className="tuval-chat-subagent">
							Back to the agent transcript
						</MetaRow>
					</button>
				</li>
			)}
			{model.rows.map((row) => (
				<NavigatorRow key={row.id} row={row} at={at} onView={onView} />
			))}
			{model.more <= 0 ? null : (
				<li className="tuval-chat-subagent-more">{model.more} more running</li>
			)}
		</ul>
	);
}
