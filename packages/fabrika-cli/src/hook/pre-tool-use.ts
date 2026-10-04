/**
 * What a `PreToolUse`/`Bash` guard reads off its envelope, and the one wire shape its verdict rides.
 *
 * `2` is the harness's one blocking `PreToolUse` code and fabrika allocates it nowhere
 * (`./harness-exit.ts`), so a deny rides `hookSpecificOutput.permissionDecision` at exit 0.
 *
 * An allow carries **no** decision field: `"allow"` is not "I have no objection" to the harness — it
 * bypasses the permission system the operator configured, which is a far larger claim than a guard
 * makes. So the allow answer is a fabrika-namespaced token the harness ignores, which still satisfies
 * the convention's positive-answer rule.
 */
import type {Envelope} from "./envelope.ts";

/** The Bash command this envelope carries, or nothing — a payload with no command is not judgeable. */
export const bashCommandOf = (envelope: Envelope): string | undefined => {
	const input = envelope.payload.tool_input;
	if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
	const command = (input as Record<string, unknown>).command;
	return typeof command === "string" ? command : undefined;
};

export type Decision =
	| {readonly _tag: "Allow"; readonly because: string}
	| {readonly _tag: "Deny"; readonly reason: string};

/** The stdout a `PreToolUse` guard answers with; `verb` names it in the allow token. */
export const preToolUseStdout = (verb: string, decision: Decision): string =>
	decision._tag === "Deny"
		? `${JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: decision.reason,
				},
			})}\n`
		: `${JSON.stringify({
				suppressOutput: true,
				fabrika: {verb, outcome: "allow", because: decision.because},
			})}\n`;
