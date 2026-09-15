/**
 * `report scratch` — the staging path a reporter writes a body into before redirecting it on stdin.
 *
 * `<temp root>/fabrika-report/<allocation-id>/<slug>`. The group's writing verbs read their body on
 * stdin, and a heredoc puts that body inside the command string the worktree-isolation verifier
 * grades as one unit — the staged route in
 * `claude-plugins/fabrika/docs/skill-conventions.md` §4 takes it back out, and it needs an
 * allocating verb to print the path it redirects from.
 *
 * **The key is a fresh id per call, because a reporter holds no claim and no lane.** `build scratch`
 * and `triage scratch` key on a claim nonce; a report is filed mid-task by whatever agent saw the
 * thing, so there is no nonce to key on and a session id alone is the shared-namespace clobber those
 * two verbs exist to prevent. A fresh id makes a collision unconstructible instead, at the cost that
 * the path is not re-derivable — which is why every caller is told to use the literal path this
 * verb printed rather than to rebuild it.
 *
 * The printed path is machine-local and must never reach a posted artifact: `report file`,
 * `report note` and `report amend` red on it (`5`).
 */
import {Effect, FileSystem} from "effect";
import {isKebabSlug} from "../build/lane.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {SLUG_MALFORMED} from "./codes.ts";

const VERB = "report scratch";

/** This allocation's directory, exported so a caller derives it rather than restating the formula. */
export const allocationDir = (tmpRoot: string, allocation: string): string =>
	`${tmpRoot.replace(/\/+$/, "")}/fabrika-report/${allocation}`;

export interface ScratchOptions {
	readonly slug: string;
	/** The fresh id that keys this allocation — the adapter's `randomUUID()`. */
	readonly allocation: string;
	/** The OS temp root, read by the adapter — the one machine fact this verb does not derive. */
	readonly tmpRoot: string;
}

export const runScratch = (
	options: ScratchOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const {slug} = options;
		if (slug.includes("/") || slug.includes("\\") || !isKebabSlug(slug)) {
			return refuse(
				SLUG_MALFORMED,
				`${VERB}: --slug "${slug}" must be a kebab-case leaf, no path separators.`,
			);
		}
		const dir = allocationDir(options.tmpRoot, options.allocation);
		const fs = yield* FileSystem.FileSystem;
		const made: string | null = yield* fs.makeDirectory(dir, {recursive: true}).pipe(
			Effect.as(null),
			Effect.catchTag("PlatformError", (cause) => Effect.succeed(cause.message)),
		);
		return made === null
			? answer(`${dir}/${slug}`)
			: refuse(FAILED, `${VERB}: cannot create ${dir}: ${made}`);
	});
