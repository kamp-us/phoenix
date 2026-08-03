/**
 * `triage codes` — print the group's shared exit taxonomy.
 *
 * The group allocates from one table, which means a caller driving several verbs has to know
 * thirteen numbers that no single `--help` page states: each verb's own help enumerates only the
 * codes *it* can reach. This verb prints the table itself, so the shipped meanings are readable at
 * runtime from the binary that owns them rather than from a document that can drift out of step with
 * it.
 *
 * It touches no repository and performs no read, which is why it takes no `--repo`.
 */
import {answer, type VerbOutcome} from "../verb.ts";
import {DELIBERATE_GAP, TRIAGE_EXIT_TABLE} from "./codes.ts";

export interface CodesInput {
	readonly json: boolean;
}

const GAP_NOTE = `triage codes: ${DELIBERATE_GAP} is unallocated — it once fused "proven absent" with "unreadable", which 7 and 11 now split.`;

export const runCodes = ({json}: CodesInput): VerbOutcome => {
	const stdout = json
		? `${JSON.stringify({gap: DELIBERATE_GAP, codes: TRIAGE_EXIT_TABLE})}\n`
		: `${TRIAGE_EXIT_TABLE.map((row) => `${row.code}\t${row.meaning}`).join("\n")}\n`;
	return answer(stdout, [GAP_NOTE]);
};
