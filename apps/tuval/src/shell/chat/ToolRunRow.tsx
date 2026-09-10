/**
 * A run of consecutive tool calls: one line — a status dot, the run's sentence, and the status as a
 * word whenever the run is not simply finished — that opens to the calls it counted (#8613).
 *
 * The dot is a state marker, not an icon — `aria-hidden`, and paired with the word beside it — so
 * neither the tint nor the shimmer is ever the only thing saying what happened (ADR 0162, Pillar 4,
 * and the manifest's state-marker bound). The shimmer collapses under `prefers-reduced-motion`
 * (`chat.css`), and the word is what survives that collapse.
 *
 * Two levels of disclosure, both controlled off the window's one `expanded` set: the run keys on its
 * own `tools:<first call id>` row key and each call keys on its own item id, so opening a call never
 * opens the run beside it and two windows over one process disclose independently.
 *
 * The names are English and fixed: `apps/tuval` has no i18n catalog, and only the product names are
 * Turkish (`.glossary/LANGUAGE.md`).
 */

import {Collapsible} from "@kampus/design";
import type {ReactElement} from "react";
import type {ToolRun} from "./rows.ts";
import {ToolCallRow} from "./ToolCallRow.tsx";
import {runSentence, runStatus, runStatusWord} from "./tool-run.ts";

export function ToolRunRow({
	calls,
	open,
	onToggle,
	expanded,
	onToggleCall,
}: {
	readonly calls: ToolRun;
	readonly open: boolean;
	readonly onToggle: (open: boolean) => void;
	/** The window's own disclosed-row ids, read for each call in this run. */
	readonly expanded: ReadonlySet<string>;
	readonly onToggleCall: (id: string, open: boolean) => void;
}): ReactElement {
	const status = runStatus(calls);
	const word = runStatusWord(status);
	return (
		<section className="tuval-chat-tool tuval-chat-tool-run" aria-label="Activity">
			<Collapsible
				open={open}
				onOpenChange={onToggle}
				trigger={
					<span className="tuval-chat-tool-run-head" data-status={status}>
						<span className="tuval-chat-tool-run-dot" data-status={status} aria-hidden="true" />
						<span
							className={
								status === "running"
									? "tuval-chat-tool-run-line tuval-chat-tool-run-shimmer"
									: "tuval-chat-tool-run-line"
							}
						>
							{runSentence(calls)}
						</span>
						{word === null ? null : (
							<span className="tuval-chat-tool-run-status" data-status={status}>
								{word}
							</span>
						)}
					</span>
				}
			>
				<ul className="tuval-chat-tool-calls" aria-label="Tool calls">
					{calls.map((call) => (
						<li key={call.id}>
							<ToolCallRow
								item={call}
								expanded={expanded.has(call.id)}
								onToggle={(next) => onToggleCall(call.id, next)}
							/>
						</li>
					))}
				</ul>
			</Collapsible>
		</section>
	);
}
