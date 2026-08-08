/**
 * `wire codes` — print the group's exit taxonomy.
 *
 * Each verb's `--help` enumerates only the codes *it* can reach, so the table itself has no other
 * runtime home. It touches no repository and performs no read, which is why it takes no `--repo`.
 */
import {answer, type VerbOutcome} from "../verb.ts";
import {ABSENT, ARTIFACT_UNKNOWN, WIRE_EXIT_TABLE} from "./codes.ts";

export interface CodesInput {
	readonly json: boolean;
}

const SPLIT_NOTE = `wire codes: ${ABSENT} (proven absent) and ${ARTIFACT_UNKNOWN} (never seen) are deliberately different codes — fusing them is what lets an unread artifact pass for one with no block.`;

export const runCodes = ({json}: CodesInput): VerbOutcome => {
	const stdout = json
		? `${JSON.stringify({codes: WIRE_EXIT_TABLE})}\n`
		: `${WIRE_EXIT_TABLE.map((row) => `${row.code}\t${row.meaning}`).join("\n")}\n`;
	return answer(stdout, [SPLIT_NOTE]);
};
