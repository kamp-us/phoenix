/**
 * `ledger draft` — validate and stage the model-authored plan block.
 *
 * A total grammar check over a closed section set, and nothing more. Whether the plan is any *good* is
 * irreducibly the skill's: a `### Approach` reading "TBD" stages cleanly. What this verb refuses is
 * the class an author cannot see — v1's section set lived only in prose, so drift produced a `Corrupt`
 * splice refusal much later with no statement of which section was wrong.
 *
 * The digest is compared against the `--body-digest` **flag** and nothing else. Falling back to the
 * value recorded on `run.json` would compare the plan against itself and make the moved-epic check
 * vacuous.
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {readAuthored} from "../build/authored.ts";
import {scannedLine} from "../build/target.ts";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {BAD_SECTIONS, EPIC_MOVED, OFF_VOCABULARY, PRECONDITION_UNKNOWN} from "./codes.ts";
import {BODY_DIGEST_RE, bodyDigest} from "./digest.ts";
import {checkPlanBlock} from "./plan-block.ts";
import {type LedgerMessages, type OpenOptions, openGround} from "./preconditions.ts";
import {planPath} from "./run.ts";
import {loadRun, maskedLeakRefusal, stage} from "./run-io.ts";

const VERB = "ledger draft";

export const MESSAGES: LedgerMessages = {
	verb: VERB,
	notAnEpic: (epic) => `${VERB}: #${epic} is not a type:epic — refusing to stage a plan for it.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — nothing was staged.`,
	notAWorktree: `${VERB}: not in a linked worktree — the run directory is unreachable.`,
};

export interface DraftOptions extends OpenOptions {
	readonly bodyDigest: string;
	readonly stdin: Effect.Effect<StdinRead>;
}

export const runDraft = (
	options: DraftOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		if (!BODY_DIGEST_RE.test(options.bodyDigest)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --body-digest must be 12 lowercase hex — got "${options.bodyDigest}".`,
			);
		}

		const authored = readAuthored(
			{
				verb: VERB,
				emptyMessage: `${VERB}: stdin held nothing — there is no plan to stage.`,
				bareAtMessage: `${VERB}: the plan text carries a bare @ path reference — it cannot be redacted.`,
			},
			yield* options.stdin,
		);
		if (authored._tag === "Refused") return authored.outcome;

		const ground = yield* openGround(MESSAGES, options);
		if (ground._tag === "Refused") return ground.outcome;
		const {epic, dir, notes} = ground;

		const run = yield* loadRun(MESSAGES, dir, notes);
		if (run._tag === "Refused") return run.outcome;

		const observed = bodyDigest(epic.body);
		if (observed !== options.bodyDigest) {
			return refuse(
				EPIC_MOVED,
				`${VERB}: the epic body moved since open (digest ${options.bodyDigest} → ${observed}) — re-open before staging.`,
				notes,
			);
		}

		const checked = checkPlanBlock(authored.text);
		if (checked._tag === "Bad") return refuse(BAD_SECTIONS, `${VERB}: ${checked.reason}`, notes);

		const leaked = maskedLeakRefusal(VERB, "plan text", authored.text);
		if (leaked !== null) return {...leaked, stderr: [...notes, ...leaked.stderr]};

		const failed = yield* stage(planPath(dir), authored.text);
		if (failed !== null) {
			return refuse(PRECONDITION_UNKNOWN, MESSAGES.unreadable(planPath(dir), failed), notes);
		}

		return answer(
			JSON.stringify({
				answer: "staged",
				epic: epic.number,
				document: "plan",
				sections: checked.sections,
				stories: checked.stories,
				bytes: authored.bytes,
			}),
			[...notes, scannedLine(VERB, checked.sections, "plan section")],
		);
	});
