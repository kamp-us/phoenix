/**
 * The ADR 0134 non-TTY posture as a pure decision core. A non-interactive
 * caller (agent/CI, no TTY) PROCEEDS without a prompt — deliberate, not a
 * hole: the humans-release boundary (ADR 0083) lives at the audit trail, not
 * as a structural TTY refuse. IO-free so it unit-tests without a terminal.
 */

export interface ConfirmInput {
	readonly isTTY: boolean;
	/** The human's answer at the prompt; `undefined` for a non-TTY caller or an EOF/cancel. */
	readonly confirmResponse: string | undefined;
}

export type ConfirmDecision =
	| {readonly _tag: "Proceed"; readonly interactive: boolean}
	| {readonly _tag: "Refuse"; readonly reason: string};

const AFFIRMATIVE = new Set(["y", "yes"]);

export const decideConfirm = (input: ConfirmInput): ConfirmDecision => {
	if (!input.isTTY) {
		return {_tag: "Proceed", interactive: false};
	}
	const answer = (input.confirmResponse ?? "").trim().toLowerCase();
	return AFFIRMATIVE.has(answer)
		? {_tag: "Proceed", interactive: true}
		: {_tag: "Refuse", reason: "not confirmed at the interactive prompt"};
};
