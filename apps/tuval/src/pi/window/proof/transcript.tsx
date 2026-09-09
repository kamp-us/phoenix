/** Rendered failure affordances only; the actual socket branch is proved by page/session-transcript-window.unit.test.tsx. */
import {createRoot} from "react-dom/client";
import {claudeSession} from "../../../ai-agent/window/fixtures.ts";
import {SessionTranscriptView} from "../../../ai-agent/window/SessionTranscript.tsx";
import type {TranscriptAnswer} from "../../../page/session-transcript.ts";
import "../../../page/styles.ts";
import "./proof.css";

const failure = {
	tag: "tuval/TranscriptReadFailed",
	message: "This transcript page could not be read. You can try it again.",
};
const older = new URLSearchParams(location.search).has("older");
const answer: TranscriptAnswer = older
	? {
			_tag: "Read",
			page: {
				items: [{kind: "user", id: "m-3", timestamp: 1, text: "Keep this loaded history visible."}],
				next: "m-3",
			},
			older: {_tag: "Failed", failure},
		}
	: {_tag: "Refused", failure};
const host = document.getElementById("proof");
if (host === null) throw new Error("Missing proof host");
createRoot(host).render(
	<div className="tuval-surface proof-desk" data-scheme="dark">
		<div className="proof-pane">
			<SessionTranscriptView
				session={claudeSession}
				answer={answer}
				onRetry={() => {}}
				onOlder={() => {}}
				onSend={() => {}}
				onBack={() => {}}
			/>
		</div>
	</div>,
);
