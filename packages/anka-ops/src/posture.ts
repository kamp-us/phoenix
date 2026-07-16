/**
 * The ADR 0134 non-TTY posture as a pure decision core — the framework primitive every
 * anka-ops write verb reuses so the humans-release boundary (ADR 0083) lives at the audit
 * trail, not as a structural TTY refuse. A non-interactive caller (agent/CI, no TTY) PROCEEDS
 * without a prompt (the action is logged for the audit record); an interactive human is asked
 * to confirm and only an affirmative answer proceeds. Keeping the decision IO-free is what
 * lets it be exhaustively unit-tested without a real terminal (mirrors cf-utils' decideLeverGuard).
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

/**
 * Decide whether a confirmation-guarded write proceeds. Non-TTY ⇒ always Proceed
 * (`interactive: false`, the caller logs the action); TTY ⇒ Proceed only on an affirmative
 * `y`/`yes`, else Refuse (a bare Enter, EOF, or any other answer is a decline).
 */
export const decideConfirm = (input: ConfirmInput): ConfirmDecision => {
	if (!input.isTTY) {
		return {_tag: "Proceed", interactive: false};
	}
	const answer = (input.confirmResponse ?? "").trim().toLowerCase();
	return AFFIRMATIVE.has(answer)
		? {_tag: "Proceed", interactive: true}
		: {_tag: "Refuse", reason: "not confirmed at the interactive prompt"};
};
