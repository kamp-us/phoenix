import {useState} from "react";
import "../../../page/styles.ts";
import {createRoot} from "react-dom/client";
import {bareSession, claudeSession, NOW} from "../../../ai-agent/window/fixtures.ts";
import {SessionList} from "../../../ai-agent/window/SessionListWindow.tsx";
import {SessionTranscriptView} from "../../../ai-agent/window/SessionTranscript.tsx";
import type {TranscriptAnswer} from "../../../page/session-transcript.ts";
import type {SessionRow} from "../../../protocol/session-list.ts";

const missing = {...bareSession, title: "Session without a folder"};
const refused = {...claudeSession, title: "Transcript read refused"};
const empty: TranscriptAnswer = {
	_tag: "Read",
	page: {items: [], next: null},
	older: {_tag: "Idle"},
};

function SessionProof({initial}: {readonly initial: SessionRow}) {
	const [session, setSession] = useState<SessionRow | null>(initial);
	const [retried, setRetried] = useState(false);
	return session === null ? (
		<SessionList
			status={{_tag: "Listed", sessions: [missing, refused], unreadable: []}}
			now={NOW}
			onActivate={(selected) => {
				setRetried(false);
				setSession(selected);
			}}
		/>
	) : (
		<SessionTranscriptView
			key={session.sessionId}
			session={session}
			unopenable={session.folder === undefined}
			answer={
				session.folder === undefined
					? null
					: retried
						? empty
						: {
								_tag: "Refused",
								failure: {
									tag: "tuval/TranscriptError",
									message: "This session's transcript could not be read.",
									path: ["session", "transcript"],
								},
							}
			}
			onSend={() => {}}
			onBack={() => setSession(null)}
			onRetry={() => setRetried(true)}
		/>
	);
}

export const mountSessionRefusalProof = (host: HTMLElement): void => {
	createRoot(host).render(
		<div className="tuval-surface proof-desk" data-scheme="dark">
			<div className="proof-pane">
				<SessionProof initial={missing} />
			</div>
			<div className="proof-pane">
				<SessionProof initial={refused} />
			</div>
		</div>,
	);
};
