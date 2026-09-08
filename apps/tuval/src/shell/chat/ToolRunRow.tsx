/**
 * A run of consecutive tool calls as one line: a status dot, the run's sentence, and the status as
 * a word whenever the run is not simply finished.
 *
 * The dot is a state marker, not an icon — `aria-hidden`, and paired with the word beside it — so
 * neither the tint nor the shimmer is ever the only thing saying what happened (ADR 0162, Pillar 4,
 * and the manifest's state-marker bound). The shimmer collapses under `prefers-reduced-motion`
 * (`chat.css`), and the word is what survives that collapse.
 *
 * Opening the run to read one call is the next slice (#8613); this row is the line and nothing else.
 */

import type {ReactElement} from "react";
import type {ToolRun} from "./rows.ts";
import {runSentence, runStatus, runStatusWord} from "./tool-run.ts";

export function ToolRunRow({calls}: {readonly calls: ToolRun}): ReactElement {
	const status = runStatus(calls);
	const word = runStatusWord(status);
	return (
		<span className="tuval-chat-tool-run" data-status={status}>
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
	);
}
