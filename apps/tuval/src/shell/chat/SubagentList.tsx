/**
 * The running-subagent list at the top of the agent window (#8405).
 *
 * Rendered off the port's subagent slot alone, so every agent program gets this list the moment its
 * mapper fills the slot — nothing here names a backend. Absent rather than empty when nothing is
 * running (Q4, the founder: "my screen should only show me enough info, not more"), which is why
 * this returns `null` instead of an empty region.
 *
 * Elapsed is the one thing the list computes rather than reads. It ticks on a timer that moves a
 * render counter and nothing else: a per-second `Msg` would checkpoint the whole session once a
 * second per running worker, and a per-second view write would do the same to this window's slot.
 */

import {MetaRow} from "@kampus/design";
import type {ReactElement} from "react";
import {useEffect, useMemo, useState} from "react";
import type {SubagentSlot} from "../../ai-agent/ports/index.ts";
import {elapsedLabel, runningSubagents, tokenLabel} from "./subagents.ts";

/** How often the elapsed readouts are re-rendered. One second: the coarsest unit the label shows. */
const TICK_MS = 1_000;

export function SubagentList({
	slots,
	now,
}: {
	readonly slots: Readonly<Record<string, SubagentSlot>>;
	readonly now: () => number;
}): ReactElement | null {
	const model = useMemo(() => runningSubagents(slots), [slots]);
	const running = model.rows.length;

	// The counter's value is never read: setting it is the re-render, and the re-render is the tick.
	const [, tick] = useState(0);
	useEffect(() => {
		if (running === 0) return;
		const timer = setInterval(() => tick((count) => count + 1), TICK_MS);
		return () => clearInterval(timer);
	}, [running]);

	if (running === 0) return null;
	const at = now();
	return (
		<ul className="tuval-chat-subagents" aria-label="Running subagents">
			{model.rows.map((row) => (
				<MetaRow as="li" className="tuval-chat-subagent" key={row.id}>
					<span className="tuval-chat-subagent-type" data-field="type">
						{row.type}
					</span>
					<MetaRow.Dot />
					<span className="tuval-chat-subagent-line" data-field="line">
						{row.lastLine}
					</span>
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
				</MetaRow>
			))}
			{model.more === 0 ? null : (
				<MetaRow as="li" className="tuval-chat-subagent-more">
					{model.more} more running
				</MetaRow>
			)}
		</ul>
	);
}
