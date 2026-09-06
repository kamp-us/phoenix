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
 * at a time; the button is gone once the answer says there is nothing older.
 */

import {AgentChatInput, Button, DesignTranslationProvider} from "@kampus/design";
import type {ReactElement} from "react";
import {useCallback, useMemo, useState} from "react";
import {failureLine} from "../../palette/call.ts";
import type {SpellFailure} from "../../protocol/messages.ts";
import type {SessionRow} from "../../protocol/session-list.ts";
import type {SessionTranscript} from "../../protocol/session-transcript.ts";
import {composerBridge} from "../../shell/chat/composer-bridge.ts";
import {tuvalDesignTranslate} from "../../shell/chat/copy.ts";
import {NO_FIRST_PROMPT} from "./rows.ts";
import "./session-list-window.css";

/** What a caller's read answered with. `null` is "the read is out", never "there is nothing". */
export type TranscriptAnswer =
	| {readonly _tag: "Read"; readonly page: SessionTranscript}
	| {readonly _tag: "Refused"; readonly failure: SpellFailure};

const COPY = {
	reading: "Reading this session's transcript…",
	empty: "This session holds no messages yet.",
	older: "Load older messages",
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
	const refusal = answer !== null && answer._tag === "Refused" ? answer.failure : null;

	const body: ReactElement =
		unopenable || refusal !== null ? (
			<p className="tuval-session-transcript-refused" role="alert">
				{refusal === null ? COPY.noFolder : failureLine(refusal)}
			</p>
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
			aria-label={session.firstPrompt ?? NO_FIRST_PROMPT}
			data-sent={sent ? "true" : "false"}
		>
			<header className="tuval-session-transcript-header">
				<Button type="button" variant="tertiary" size="sm" onClick={onBack}>
					{COPY.back}
				</Button>
				<h2>{session.firstPrompt ?? NO_FIRST_PROMPT}</h2>
			</header>
			{older === null || onOlder === undefined ? null : (
				<Button type="button" variant="tertiary" size="sm" onClick={onOlder}>
					{COPY.older}
				</Button>
			)}
			{body}
			<DesignTranslationProvider translate={tuvalDesignTranslate}>
				<AgentChatInput variant="focused" bridge={composer.bridge} />
			</DesignTranslationProvider>
		</section>
	);
}
