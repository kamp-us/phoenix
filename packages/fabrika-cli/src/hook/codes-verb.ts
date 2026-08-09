/**
 * `hook codes` — print the group's exit taxonomy.
 *
 * Each verb's `--help` enumerates only the codes *it* can reach, so the table itself has no other
 * runtime home. It reads nothing and always exits 0.
 */
import {answer, type VerbOutcome} from "../verb.ts";
import {ENVELOPE_UNKNOWN, HOOK_EXIT_TABLE, MALFORMED_ENVELOPE} from "./codes.ts";

export interface CodesInput {
	readonly json: boolean;
}

const SPLIT_NOTE = `hook codes: ${MALFORMED_ENVELOPE} (read and provably not an envelope) and ${ENVELOPE_UNKNOWN} (never read) are deliberately different codes — fusing them is what lets an unread fd 0 pass for a bad payload.`;

export const runCodes = ({json}: CodesInput): VerbOutcome => {
	const stdout = json
		? `${JSON.stringify({codes: HOOK_EXIT_TABLE})}\n`
		: `${HOOK_EXIT_TABLE.map((row) => `${row.code}\t${row.meaning}`).join("\n")}\n`;
	return answer(stdout, [SPLIT_NOTE]);
};
