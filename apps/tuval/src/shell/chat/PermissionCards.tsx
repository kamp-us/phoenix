/**
 * The pending permission requests, one card each.
 *
 * The card list is driven straight off `state.permissions`, and a card leaves it on the
 * confirmation of its answer rather than on the click that answered it (#8006) — so a disappearing
 * card means the agent settled the request, never that a decision has been sent. Answering marks
 * the card instead, and every window over the process renders the same mark from the same shared
 * state: whichever one clicks, both stop offering the buttons.
 *
 * An `unresolved` card offers no second answer. Its first answer may or may not have been applied,
 * so another click would be a retry of an authorization nobody asked to repeat; only the agent's
 * own resolution clears it.
 *
 * Each card is a named `region`: `Card` renders as a `section` labelled by its own visible title, so
 * a screen reader's landmark list distinguishes two pending requests instead of listing two unnamed
 * boxes (`.patterns/manti-accessibility.md`, the third hand-authored-label case — pointed at the
 * heading rather than retyped).
 */

import {Button, Card, Input} from "@kampus/design";
import type {ReactElement} from "react";
import {useCallback, useId, useState} from "react";
import type {PendingPermission, PermissionDecision} from "../../ai-agent/ports/index.ts";

export interface PermissionAnswer {
	readonly request: string;
	readonly decision: PermissionDecision;
	readonly message?: string;
}

const decisionLabel: Readonly<Record<PermissionDecision, string>> = {
	"allow-once": "Allow once",
	"allow-always": "Allow always",
	deny: "Deny",
};

/** What the card says about an answer that has left but not landed. `open` says nothing. */
function ProgressLine({
	progress,
}: {
	readonly progress: PendingPermission["progress"];
}): ReactElement | null {
	if (progress.status === "open") return null;
	const decision = decisionLabel[progress.decision];
	return progress.status === "answering" ? (
		<p className="tuval-chat-permission-progress" data-status="answering" role="status">
			Sending “{decision}” — waiting for the agent to confirm it.
		</p>
	) : (
		<p className="tuval-chat-permission-progress" data-status="unresolved" role="alert">
			“{decision}” was not confirmed and may or may not have been applied. Only the agent can settle
			this request now.
		</p>
	);
}

function PermissionCard({
	id,
	pending,
	onAnswer,
}: {
	readonly id: string;
	readonly pending: PendingPermission;
	readonly onAnswer: (answer: PermissionAnswer) => void;
}): ReactElement {
	const titleId = useId();
	const [message, setMessage] = useState("");
	const {request, progress} = pending;
	const open = progress.status === "open";
	const answer = useCallback(
		(decision: PermissionDecision) => {
			const trimmed = message.trim();
			onAnswer(
				trimmed === "" ? {request: id, decision} : {request: id, decision, message: trimmed},
			);
		},
		[id, message, onAnswer],
	);
	return (
		<Card
			as="section"
			className="tuval-chat-permission"
			aria-labelledby={titleId}
			data-status={progress.status}
		>
			<h3 id={titleId} className="tuval-chat-permission-title">
				{request.title}
			</h3>
			<p className="tuval-chat-permission-name">{request.displayName}</p>
			<p className="tuval-chat-permission-description">{request.description}</p>
			<pre className="tuval-chat-pre">{JSON.stringify(request.input, null, 2) ?? "null"}</pre>
			<Input
				label="Message (optional)"
				value={message}
				disabled={!open}
				onChange={(event) => setMessage(event.currentTarget.value)}
			/>
			<div className="tuval-chat-permission-actions">
				<Button
					type="button"
					variant="primary"
					size="sm"
					disabled={!open}
					onClick={() => answer("allow-once")}
				>
					{decisionLabel["allow-once"]}
				</Button>
				{request.offersAlways ? (
					<Button
						type="button"
						variant="secondary"
						size="sm"
						disabled={!open}
						onClick={() => answer("allow-always")}
					>
						{decisionLabel["allow-always"]}
					</Button>
				) : null}
				<Button
					type="button"
					variant="danger"
					size="sm"
					disabled={!open}
					onClick={() => answer("deny")}
				>
					{decisionLabel.deny}
				</Button>
			</div>
			<ProgressLine progress={progress} />
		</Card>
	);
}

/**
 * A process that raises none renders nothing at all — not an empty-state treatment. A permission
 * card is an interruption, and the absence of one is the ordinary case rather than a void the
 * usability pillar asks to fill (ADR 0162, Pillar 3).
 */
export function PermissionCards({
	permissions,
	onAnswer,
}: {
	readonly permissions: Readonly<Record<string, PendingPermission>>;
	readonly onAnswer: (answer: PermissionAnswer) => void;
}): ReactElement | null {
	const entries = Object.entries(permissions);
	if (entries.length === 0) return null;
	return (
		<div className="tuval-chat-permissions">
			{entries.map(([id, pending]) => (
				<PermissionCard key={id} id={id} pending={pending} onAnswer={onAnswer} />
			))}
		</div>
	);
}
