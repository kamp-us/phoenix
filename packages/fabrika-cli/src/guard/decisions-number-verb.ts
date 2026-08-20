/**
 * `guard decisions-index validate` — ported off v1's `decisions-index validate` (epic #5720).
 *
 * The verb is the IO boundary and nothing else: list the decision corpus, read each record, hand
 * them to the pure rule in `./decisions-number.ts`, seat the answer on the group's exit taxonomy.
 *
 * Where the corpus is comes from `decisionsDir` (#6433), the same resolver `adr` and `governance`
 * read, so a repo that keeps its records elsewhere is scanned rather than reported empty.
 *
 * v1's other three modes did not come with it: `generate`/`check` served a committed
 * `.decisions/index.md` that ADR 0126 deleted, and `compact`/`next` are `fabrika adr`'s
 * (`../adr/`), not a guard's. `validate` is the whole of what CI ran.
 */

import {Effect, type FileSystem, Path} from "effect";
import {isRecordCandidate} from "../adr/records.ts";
import {decisionsDirOr} from "../config/paths.ts";
import {discoverRepoRoot} from "../delegate/root.ts";
import {exists, type ReadFailed, readDir, readFile} from "../io/fs.ts";
import type {VerbOutcome} from "../verb.ts";
import {atFile} from "./annotate.ts";
import {type DecisionFile, defectFiles, describeDefect, findDefects} from "./decisions-number.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	skipped,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard decisions-index validate";

export interface DecisionsIndexGuardOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const judge = (
	root: string,
	corpus: string,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const dir = path.join(root, corpus);
		if (!(yield* exists(dir))) {
			return zeroScope(
				`${VERB}: ${corpus}/ does not exist under ${root} — the guard read no records at all, fail-closed (ADR 0092). Is the repo root correct?`,
			);
		}
		// A name that leads with a digit and ends `.md` is a record or a MALFORMED one, and both are
		// in scope: scoping to well-formed names only would let `0284 -bad.md` leave the guard's
		// sight entirely, which is the collision the lock exists to catch.
		const names = (yield* readDir(dir)).filter(isRecordCandidate).sort();
		if (names.length === 0) {
			return zeroScope(
				`${VERB}: ${corpus}/ holds ZERO decision records — the guard compared no numbers, fail-closed (ADR 0092).`,
			);
		}
		const files: Array<DecisionFile> = [];
		for (const file of names) {
			files.push({file, text: yield* readFile(path.join(dir, file))});
		}
		const defects = findDefects(files);
		if (defects.length === 0) {
			return clean(
				`${VERB}: all ${files.length} ${corpus}/ records carry the four index fields, a filename number matching their \`id\`, and no duplicate id`,
				files.length,
			);
		}
		const report = [
			`${VERB}: ${defects.length} ADR number-lock defect(s) across ${files.length} record(s):`,
			...defects.map(describeDefect),
			"",
			"An ADR's number lives on two axes — the filename prefix and the frontmatter `id` — and they",
			"must name the same record, or a number collision hides behind whichever axis still differs",
			"(the #1471 class, the ADR 0074 number lock). Renumber the newer record and rename its file.",
		].join("\n");
		return violation(
			report,
			annotationsOrNone(() =>
				defects.flatMap((defect) =>
					defectFiles(defect).map((file) =>
						atFile(
							"error",
							`${corpus}/${file}`,
							`${describeDefect(defect).trim()} — the ADR number lock (ADR 0074) requires the filename prefix and the frontmatter \`id\` to name one record, uniquely. Fix: renumber the newer record and rename its file to match.`,
						),
					),
				),
			),
		);
	});

export const runDecisionsIndexGuard = (
	options: DecisionsIndexGuardOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const root =
			options.root ?? (yield* discoverRepoRoot(options.cwd).pipe(Effect.map((r) => r ?? null)));
		if (root === null) {
			return emitVerdict(
				unknown(
					`${VERB}: no repo root at or above ${options.cwd} — nothing to scope the scan to, so the verdict is UNKNOWN.`,
				),
				options.env,
			);
		}
		// Read from `root`, not `cwd`: the corpus path is repo-relative, so it must resolve against
		// the same root the scan is scoped to when `--root` names one the cwd is not under.
		const corpus = yield* decisionsDirOr(
			VERB,
			root,
			null,
			"there is no corpus to scan and this guard has nothing to lock.",
		);
		switch (corpus._tag) {
			case "Refused":
				return emitVerdict(unknown(corpus.message), options.env);
			case "Declined":
				return emitVerdict(skipped(corpus.message), options.env);
			case "Dir":
				return emitVerdict(yield* judge(root, corpus.dir), options.env);
		}
	}).pipe(
		Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
			Effect.succeed(
				emitVerdict(
					unknown(
						`${VERB}: cannot read ${failure.path}: ${failure.reason} — the scan could not be completed, so the verdict is UNKNOWN, never clean.`,
					),
					options.env,
				),
			),
		),
	);
