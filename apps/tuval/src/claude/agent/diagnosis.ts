/**
 * The only readings this layer takes off a thrown SDK value, and the only guidance it is allowed to
 * put in front of an operator (#8010).
 *
 * `@anthropic-ai/claude-agent-sdk@0.3.259` exports one error class, `AbortError`, and nothing else.
 * Every process and control failure is a plain `Error` with own properties stamped onto it — an
 * `errorClass` from a fixed vocabulary, plus `code` and `exitCode` where the failure has one
 * (`sdk.mjs`). Those stamps are the discriminant. The `message` beside them is not: for
 * `control_request_failed` it is whatever string the CLI returned, and for `error_result` it is
 * text the model wrote, so neither is copy this layer may repeat.
 *
 * A cause with no row here gets `null` — no diagnosis rather than a guessed one. The operation's
 * own name is then the whole message, and the thrown value is still on the refusal's `cause`.
 */

/** The stamps `sdk.mjs` writes onto a thrown `Error`. None of them is declared in `sdk.d.ts`. */
interface Stamped {
	readonly errorClass?: unknown;
	readonly exitCode?: unknown;
}

/**
 * The one reading taken off message text, because `query()` throws it during setup before any
 * process exists and so nothing stamps it: `Native CLI binary for ${platform}-${arch} not found.
 * Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, …` (`sdk.mjs` at the pin). It
 * is the SDK's own literal with no caller data in it, and a missing install is the failure an
 * operator most needs told, so the prefix is matched rather than dropped with everything else.
 */
const MISSING_BINARY = "Native CLI binary for";

const guidanceFor = (errorClass: string, stamped: Stamped): string | null => {
	switch (errorClass) {
		case "executable_not_found":
			return "Claude Code is not installed where this session looked for it";
		case "executable_launch_failed":
			return "the Claude Code binary is there but will not run on this machine";
		case "initialize_timeout":
			return "the CLI did not finish starting up; check your Claude Code authentication and network";
		case "spawn_failed":
			return "the Claude Code CLI could not be started";
		case "process_exited_nonzero":
			return typeof stamped.exitCode === "number"
				? `the Claude Code CLI exited with code ${stamped.exitCode}`
				: "the Claude Code CLI exited before it answered";
		case "process_killed_by_signal":
			return "the Claude Code CLI was killed before it answered";
		default:
			return null;
	}
};

/** What is known about a thrown value, as a sentence an operator can act on — or `null`. */
export const diagnose = (cause: unknown): string | null => {
	if (typeof cause !== "object" || cause === null) return null;
	const {errorClass} = cause as Stamped;
	if (typeof errorClass === "string") return guidanceFor(errorClass, cause as Stamped);
	return cause instanceof Error && cause.message.startsWith(MISSING_BINARY)
		? "the Claude Code CLI that ships with the SDK is not installed for this platform"
		: null;
};
