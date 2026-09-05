/**
 * The pending permission requests, one card each.
 *
 * The card list is driven straight off `state.permissions` — the core drops a request the moment
 * its `answer` Msg lands (`../../ai-agent/core/machine.ts`), so a card disappears because the state
 * no longer holds it and never because this component remembers having answered. That is what makes
 * two windows over one process agree: they render the same map, and either one's answer clears it
 * from both.
 *
 * Each card is a named `region`: `Card` renders as a `section` labelled by its own visible title, so
 * a screen reader's landmark list distinguishes two pending requests instead of listing two unnamed
 * boxes (`.patterns/manti-accessibility.md`, the third hand-authored-label case — pointed at the
 * heading rather than retyped).
 */

import {Button, Card, Input} from "@kampus/design";
import type {ReactElement} from "react";
import {useCallback, useId, useState} from "react";
import type {PermissionDecision, PermissionRequest} from "../../ai-agent/ports/index.ts";

export interface PermissionAnswer {
	readonly request: string;
	readonly decision: PermissionDecision;
	readonly message?: string;
}

function PermissionCard({
	id,
	request,
	onAnswer,
}: {
	readonly id: string;
	readonly request: PermissionRequest;
	readonly onAnswer: (answer: PermissionAnswer) => void;
}): ReactElement {
	const titleId = useId();
	const [message, setMessage] = useState("");
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
		<Card as="section" className="tuval-chat-permission" aria-labelledby={titleId}>
			<h3 id={titleId} className="tuval-chat-permission-title">
				{request.title}
			</h3>
			<p className="tuval-chat-permission-name">{request.displayName}</p>
			<p className="tuval-chat-permission-description">{request.description}</p>
			<pre className="tuval-chat-pre">{JSON.stringify(request.input, null, 2) ?? "null"}</pre>
			<Input
				label="Message (optional)"
				value={message}
				onChange={(event) => setMessage(event.currentTarget.value)}
			/>
			<div className="tuval-chat-permission-actions">
				<Button type="button" variant="primary" size="sm" onClick={() => answer("allow-once")}>
					Allow once
				</Button>
				{request.offersAlways ? (
					<Button
						type="button"
						variant="secondary"
						size="sm"
						onClick={() => answer("allow-always")}
					>
						Allow always
					</Button>
				) : null}
				<Button type="button" variant="danger" size="sm" onClick={() => answer("deny")}>
					Deny
				</Button>
			</div>
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
	readonly permissions: Readonly<Record<string, PermissionRequest>>;
	readonly onAnswer: (answer: PermissionAnswer) => void;
}): ReactElement | null {
	const entries = Object.entries(permissions);
	if (entries.length === 0) return null;
	return (
		<div className="tuval-chat-permissions">
			{entries.map(([id, request]) => (
				<PermissionCard key={id} id={id} request={request} onAnswer={onAnswer} />
			))}
		</div>
	);
}
