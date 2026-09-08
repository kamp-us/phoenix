/**
 * One session read in place of the list: its transcript, read-only, with the composer whose first
 * send turns the window into an ordinary live session (epic #8070, rulings 2 and 5).
 *
 * **Nothing here writes.** The transcript arrives as an answer the caller read through
 * `session.transcript` (`../session-transcript.ts`), which opens no process and no restore state,
 * and the only act this surface offers is the send — which is the moment ruling 2 says the
 * read-only half ends. The decision of what a send does is `./opening.ts`'s `send`, not this
 * component's: the first one asks for the spawn and the second one asks for nothing.
 *
 * **A missing session is a sentence, never an empty transcript.** A store that has since lost the
 * session, and a row the store filed under no folder, both land as a refusal the window renders;
 * an empty transcript is reserved for the session that really holds nothing, because a reader who
 * cannot tell the two apart learns nothing from either.
 *
 * **Older history is asked for, not fetched whole.** `onOlder` walks the port's own cursor one page
 * at a time; the button is gone once the answer says there is nothing older. An older page that
 * fails is said beside the history rather than in place of it, and the button stays — the cursor
 * did not move, so pressing it again asks for the same page rather than skipping past it.
 */

import {AgentChatInput, Button, DesignTranslationProvider} from "@kampus/design";
import type {ReactElement} from "react";
import {useCallback, useMemo, useState} from "react";
import type {OlderRead, TranscriptAnswer} from "../../page/session-transcript.ts";
import {failureLine} from "../../palette/call.ts";
import type {SessionRow} from "../../protocol/session-list.ts";
import type {SessionTranscript} from "../../protocol/session-transcript.ts";
import {composerBridge} from "../../shell/chat/composer-bridge.ts";
import {tuvalDesignTranslate} from "../../shell/chat/copy.ts";
import {sessionLabel} from "./rows.ts";
import "./session-list-window.css";

const COPY = {
	retry: "Try reading this transcript again",
	reading: "Reading this session's transcript…",
	empty: "This session holds no messages yet.",
	older: "Load older messages",
	olderReading: "Reading older messages…",
	olderFailed: "The older messages could not be read, so this transcript stops here.",
	olderRetry: "Try the older messages again",
	back: "Back to the session list",
	noFolder: "This session's store recorded no folder, so it cannot be opened.",
} as const;

const itemText = (item: SessionTranscript["items"][number]): string =>
	item.kind === "tool" ? `${item.name} — ${item.result.text}` : item.text;

/** One transcript item as a row. Read-only: nothing here is expandable, answerable or resendable. */
const TranscriptRow = ({
	item,
}: {
	readonly item: SessionTranscript["items"][number];
}): ReactElement => (
	<li className={`tuval-session-transcript-row tuval-session-transcript-row-${item.kind}`}>
		<span className="tuval-session-transcript-kind">{item.kind}</span>
		<span className="tuval-session-transcript-text">{itemText(item)}</span>
	</li>
);

export interface SessionTranscriptProps {
	readonly session: SessionRow;
	/** The page to render. `null` while the read is out. */
	readonly answer: TranscriptAnswer | null;
	/** Ask for the page older than the one on screen. Absent means this caller does not page. */
	readonly onOlder?: () => void;
	readonly onRetry?: () => void;
	/** The operator sent. What that does to the process is the caller's, through `send`. */
	readonly onSend: (text: string) => void;
	/** Leave the session and put the list back in this window. */
	readonly onBack: () => void;
	/** Set when the row itself cannot be opened — the store filed it under no folder. */
	readonly unopenable?: boolean;
}

export function SessionTranscriptView({
	session,
	answer,
	onOlder,
	onRetry,
	onSend,
	onBack,
	unopenable = false,
}: SessionTranscriptProps): ReactElement {
	const [sent, setSent] = useState(false);
	const submit = useCallback(
		(text: string) => {
			setSent(true);
			onSend(text);
		},
		[onSend],
	);

	const composer = useMemo(
		() =>
			composerBridge({
				initialPhase: "idle",
				initialModels: {current: null, available: []},
				initialThinking: {current: null, available: []},
				initialCommands: [],
				onPrompt: submit,
				onInterrupt: () => {},
				onSetModel: () => {},
				onSetThinkingLevel: () => {},
			}),
		[submit],
	);

	const items = answer?._tag === "Read" ? answer.page.items : [];
	const older = answer?._tag === "Read" ? answer.page.next : null;
	const olderRead: OlderRead = answer?._tag === "Read" ? answer.older : {_tag: "Idle"};
	const olderFailure = olderRead._tag === "Failed" ? olderRead.failure : null;
	const refusal = answer !== null && answer._tag === "Refused" ? answer.failure : null;

	const body: ReactElement =
		unopenable || refusal !== null ? (
			<div className="tuval-session-transcript-refused">
				<p role="alert">{refusal === null ? COPY.noFolder : failureLine(refusal)}</p>
				{!unopenable && refusal !== null && onRetry !== undefined ? (
					<Button type="button" variant="tertiary" size="sm" onClick={onRetry}>
						{COPY.retry}
					</Button>
				) : null}
			</div>
		) : answer === null ? (
			<p className="tuval-session-transcript-note">{COPY.reading}</p>
		) : items.length === 0 ? (
			<p className="tuval-session-transcript-note">{COPY.empty}</p>
		) : (
			<ul className="tuval-session-transcript-items">
				{items.map((item) => (
					<TranscriptRow key={item.id} item={item} />
				))}
			</ul>
		);

	return (
		<section
			className="tuval-session-transcript"
			aria-label={sessionLabel(session)}
			data-sent={sent ? "true" : "false"}
		>
			<header className="tuval-session-transcript-header">
				<Button type="button" variant="tertiary" size="sm" onClick={onBack}>
					{COPY.back}
				</Button>
				<h2>{sessionLabel(session)}</h2>
			</header>
			{older === null || onOlder === undefined ? null : (
				<div className="tuval-session-transcript-older">
					<Button
						type="button"
						variant="tertiary"
						size="sm"
						disabled={olderRead._tag === "Reading"}
						onClick={onOlder}
					>
						{olderFailure === null ? COPY.older : COPY.olderRetry}
					</Button>
					{olderRead._tag === "Reading" ? (
						<p className="tuval-session-transcript-note" role="status">
							{COPY.olderReading}
						</p>
					) : null}
					{olderFailure === null ? null : (
						<p className="tuval-session-transcript-refused" role="alert">
							{`${COPY.olderFailed} ${failureLine(olderFailure)}`}
						</p>
					)}
				</div>
			)}
			{body}
			<DesignTranslationProvider translate={tuvalDesignTranslate}>
				<AgentChatInput variant="focused" bridge={composer.bridge} />
			</DesignTranslationProvider>
		</section>
	);
}
