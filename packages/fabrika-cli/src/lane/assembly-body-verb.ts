/**
 * `lane assembly-body` — the guard the epic run's PR body passes through on its way to `gh pr create`.
 *
 * It is a **relay**: the body arrives on stdin and a body that closes its epic leaves on stdout
 * byte-for-byte, so `operate`'s fence stays literal and pipes rather than deriving anything. A body
 * that does not close the epic is refused and nothing is printed, which is what makes the refusal
 * bite — a fence piping into `gh pr create --body-file -` opens no PR when the pipe carries nothing.
 *
 * It reads no board and takes no `--repo`, deliberately: the epic-ness of the number was already
 * established one command earlier in the same fence, by `lane assembly-pr`'s `56`, and a second
 * network read would only add an UNKNOWN to a judgement the bytes on stdin fully decide.
 */
import {Effect} from "effect";
import {leakRefusal, readAuthored} from "../build/authored.ts";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {tailBodyRead} from "./assembly-body.ts";
import {TAIL_NOT_CLOSING} from "./codes.ts";

const VERB = "fabrika lane assembly-body";

const SURFACE = {
	verb: VERB,
	emptyMessage: `${VERB}: stdin held nothing — the assembly PR's body is the input.`,
	bareAtMessage: `${VERB}: the body is a bare @ path reference — write the body, not a pointer to it.`,
};

export interface AssemblyBodyOptions {
	readonly epic: number;
	readonly stdin: Effect.Effect<StdinRead>;
}

export const runAssemblyBody = ({epic, stdin}: AssemblyBodyOptions): Effect.Effect<VerbOutcome> =>
	Effect.gen(function* () {
		const authored = readAuthored(SURFACE, yield* stdin);
		if (authored._tag === "Refused") return authored.outcome;
		const body = authored.text;

		const leaked = leakRefusal(VERB, body);
		if (leaked !== null) return leaked;

		const read = tailBodyRead(body, epic);
		if (read._tag === "Unclosing") {
			return refuse(
				TAIL_NOT_CLOSING,
				`${VERB}: the body carries no closing keyword aimed at #${epic} — ${read.read}. An epic run is one branch and one PR, so a tail that does not close its epic folds the lane to a terminal over an open epic. Write "Fixes #${epic}" into the body, or leave the run's PR unopened.`,
			);
		}
		return answer(body, [
			`${VERB}: #${epic} is closed by this body; ${authored.bytes} byte(s) relayed unchanged.`,
		]);
	});
