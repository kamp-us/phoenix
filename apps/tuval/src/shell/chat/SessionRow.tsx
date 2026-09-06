/**
 * Everything a backend says *about* the session, as one row.
 *
 * There is no branch per notice kind here and none anywhere else under `shell/chat/`. The Claude
 * SDK alone raises some fifteen `system` subtypes — status, the three hook frames, a local
 * command's output, a notification, the two refusal arms, the background-task and session-state
 * changes, persisted files, memory recall, the informational catch-all — and a rate limit and an
 * auth status arrive beside them. A window that grew a case per subtype is a window the sixteenth
 * subtype breaks, so they all cross as `SystemItem` (`ports/transcript-item.ts`) and land here. A
 * subtype that wants a different line is a mapper writing a different `text` (#8151, #8152).
 *
 * Consecutive notices are one row rather than a stack (`rows.ts`, `SessionRun`): a burst of hook
 * frames mid-turn would otherwise push whatever the reader was on down the page, frame by frame.
 * The line always showing is the newest one — the session's current word — and the rest of the run
 * folds away with the details.
 *
 * The disclosure is `@kampus/design`'s `Collapsible`, the primitive `ToolRow` and `ThinkingRow`
 * use, so `aria-expanded`/`aria-controls` are the primitive's and the accessible name is the
 * summary line (`.patterns/manti-accessibility.md`). A lone notice carrying no detail has nothing
 * to disclose and renders as plain text: a control that opens an empty region announces a promise
 * the row cannot keep.
 */

import {Collapsible} from "@kampus/design";
import type {ReactElement} from "react";
import type {SystemItem} from "../../ai-agent/ports/index.ts";
import type {SessionRun} from "./rows.ts";

/**
 * One notice's line, which for the newest is also the disclosure's accessible name. The first line
 * carrying anything; a fixed word when the notice is whitespace, so the control is never nameless.
 */
export const sessionLine = (item: SystemItem): string => {
	const first =
		item.text
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";
	return first.length === 0 ? "Session notice" : first;
};

/** How much the row is holding back. Words rather than a bare count, which names nothing. */
const earlierLine = (count: number): string =>
	`${count} earlier ${count === 1 ? "notice" : "notices"}`;

export function SessionRow({
	run,
	expanded,
	onToggle,
}: {
	readonly run: SessionRun;
	readonly expanded: boolean;
	readonly onToggle: (open: boolean) => void;
}): ReactElement {
	const latest = run[run.length - 1] ?? run[0];
	const earlier = run.length - 1;
	const alone = earlier === 0 ? latest.detail : undefined;
	if (earlier === 0 && alone === undefined) {
		return <p className="tuval-chat-text tuval-chat-session-line">{sessionLine(latest)}</p>;
	}
	return (
		<Collapsible
			className="tuval-chat-session"
			open={expanded}
			onOpenChange={onToggle}
			trigger={
				<span className="tuval-chat-session-head">
					<span className="tuval-chat-session-line">{sessionLine(latest)}</span>
					{earlier === 0 ? null : (
						<span className="tuval-chat-session-count">{earlierLine(earlier)}</span>
					)}
				</span>
			}
		>
			{alone !== undefined ? (
				// A lone notice's line is the trigger, so the panel is its detail and nothing else —
				// restating the line under the control that already says it is noise read twice.
				<pre className="tuval-chat-pre">{alone}</pre>
			) : (
				// A run reads as a log, oldest-first, in the order the session raised it.
				<ol className="tuval-chat-session-detail">
					{run.map((item) => (
						<li key={item.id} className="tuval-chat-session-entry">
							<p className="tuval-chat-text">{sessionLine(item)}</p>
							{item.detail === undefined ? null : (
								<pre className="tuval-chat-pre">{item.detail}</pre>
							)}
						</li>
					))}
				</ol>
			)}
		</Collapsible>
	);
}
