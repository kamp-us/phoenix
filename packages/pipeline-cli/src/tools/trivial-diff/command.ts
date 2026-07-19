/**
 * The `trivial-diff` tool — `pipeline-cli trivial-diff classify [flags]`.
 *
 *   pipeline-cli trivial-diff classify                 # read the diff from stdin
 *   pipeline-cli trivial-diff classify --diff-file d.patch
 *   pipeline-cli trivial-diff classify --max-lines 20  # the single-file line bound N
 *   pipeline-cli trivial-diff classify --repo owner/r  # repo to resolve the live boundary from
 *
 * The deterministic, fail-closed trivial-diff classifier (ADR
 * [0120](../../../../../.decisions/0120-stage-right-sizing-trivial-diff-lighter-gate.md) §1).
 * Prints the verdict word (`trivial` / `non-trivial`) to **stdout** and the deciding
 * reason to **stderr**, exiting 0 on any completed classification — the verdict is the
 * value, read it from stdout. This tool only *builds* the predicate; it is NOT yet
 * wired into the executor (that is sibling #1559) and the lighter gate it routes to is
 * sibling #1560's measurement-gated adoption. It ships correct, tested, and dormant.
 *
 * The IO lives here (the thin bin), the predicate in `trivial-diff.ts` (the pure core):
 *   - The live `CONTROL_PLANE_RE` is re-resolved from `origin/main` at run time via the
 *     REST raw contents endpoint (`?ref=main`) — never a stale snapshot (the #981
 *     mis-classification class; ADR 0120 §1.3). An unreadable boundary resolves to
 *     `null`, which the core treats as fail-closed (every diff non-trivial).
 *   - The `extractControlPlaneRe` parse is single-sourced from `codeowners-cp` — the
 *     same canonical `CONTROL_PLANE_RE='…'` reader the §CP↔CODEOWNERS gate uses, never
 *     a second copy of the boundary grammar.
 *
 * Fail-closed by construction: every failure path — a gh/network failure, an
 * unparseable boundary, an unreadable diff — yields `non-trivial`, so a classifier
 * miss can only ever over-route to the full (correct) fan-out, never under-gate.
 */
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {extractControlPlaneRe} from "../codeowners-cp/codeowners-cp.ts";
import {FORMATS_PATH} from "../codeowners-cp/gate.ts";
import {parseGuardAdrRe} from "../guard-content-probe/guard-content-probe.ts";
import {classify} from "./trivial-diff.ts";

/**
 * The default single-file line bound `N`. Justified against the frozen task set
 * (`reports/token-economics-measurement.md`): the §1 write-code frozen input
 * (PR #1224, a `biome.jsonc` lint fix) is 5 changed lines in one file, and the
 * trivial-path motivating case (#1399, a one-line `CLAUDE.md` doc fix) is a single
 * line — both well within. 20 covers the measured single-file trivial class (one-line
 * stub/comment/value fixes the #1486 small-PR drain names) with headroom while staying
 * far below a reviewable multi-hunk refactor. Adoption is measurement-gated (ADR 0112,
 * sibling #1560), so `N` is a tunable starting bound, overridable with `--max-lines`.
 */
const DEFAULT_MAX_LINES = 20;

const diffFileFlag = Flag.string("diff-file").pipe(
	Flag.optional,
	Flag.withDescription("read the unified diff from this file (default: stdin)"),
);

const maxLinesFlag = Flag.integer("max-lines").pipe(
	Flag.withDefault(DEFAULT_MAX_LINES),
	Flag.withDescription(
		"the single-file changed-line bound N below which a non-doc file is trivial",
	),
);

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"owner/repo to resolve the live CONTROL_PLANE_RE from (default: CLAUDE_PIPELINE_REPO / gh repo view)",
	),
);

/** Read the diff: from `--diff-file` if given, else stdin (fd 0). Any read failure ⇒ null (fail-closed). */
const readDiff = (diffFile: Option.Option<string>): string | null => {
	// biome-ignore lint/plugin: best-effort read — any read failure is absorbed into null (fail-closed: the core then refuses), never the E channel; a total helper, not Effect-cosplay.
	try {
		return Option.match(diffFile, {
			onSome: (path) => readFileSync(path, "utf8"),
			onNone: () => readFileSync(0, "utf8"),
		});
	} catch {
		return null;
	}
};

/** Resolve owner/repo: `--repo`, else `CLAUDE_PIPELINE_REPO`, else `gh repo view`. null on failure. */
const resolveRepo = (repo: Option.Option<string>): string | null => {
	const explicit = Option.getOrUndefined(repo) ?? process.env.CLAUDE_PIPELINE_REPO;
	if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
	// biome-ignore lint/plugin: best-effort probe — a failed gh repo view is absorbed into null (unresolved repo ⇒ fail-closed), never the E channel; a total helper, not Effect-cosplay.
	try {
		return execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return null;
	}
};

/**
 * Fetch `gh-issue-intake-formats.md` raw from `origin/main` (`?ref=main`) — the single source
 * for both the §CP boundary (`CONTROL_PLANE_RE`) and the guard-touching-ADR vocabulary
 * (`GUARD_ADR_RE`, ADR 0164). Returns null on any failure (gh missing/unauth, repo unresolved,
 * file absent); both bounds then fail closed. One fetch, both regexes — never a second network
 * round-trip nor a second copy of the boundary grammar.
 */
const fetchFormatsRaw = (repo: string | null): string | null => {
	if (repo === null) return null;
	// biome-ignore lint/plugin: best-effort probe — any failure (gh missing/unauth, repo unresolved, file absent) is absorbed into null (both bounds then fail closed), never the E channel; a total helper, not Effect-cosplay.
	try {
		return execFileSync(
			"gh",
			[
				"api",
				`repos/${repo}/contents/${FORMATS_PATH}?ref=main`,
				"-H",
				"Accept: application/vnd.github.raw",
			],
			{encoding: "utf8"},
		);
	} catch {
		return null;
	}
};

const classifyCmd = Command.make(
	"classify",
	{diffFile: diffFileFlag, maxLines: maxLinesFlag, repo: repoFlag},
	Effect.fn(function* ({diffFile, maxLines, repo}) {
		const formatsRaw = fetchFormatsRaw(resolveRepo(repo));
		const controlPlaneRe = formatsRaw === null ? null : extractControlPlaneRe(formatsRaw);
		const guardAdrRe = formatsRaw === null ? null : parseGuardAdrRe(formatsRaw);
		const diff = readDiff(diffFile);
		if (diff === null) {
			// Unreadable diff is itself fail-closed: classify as non-trivial.
			yield* Effect.sync(() =>
				process.stderr.write("trivial-diff: could not read the diff — default-deny.\n"),
			);
			yield* Console.log("non-trivial");
			return;
		}
		const result = classify(diff, {controlPlaneRe, lineBudget: maxLines, guardAdrRe});
		yield* Effect.sync(() => process.stderr.write(`trivial-diff: ${result.reason}\n`));
		yield* Console.log(result.verdict);
	}),
).pipe(
	Command.withDescription(
		"Classify a unified diff as trivial / non-trivial (fail-closed; ADR 0120 §1)",
	),
);

export const trivialDiffCommand = Command.make("trivial-diff").pipe(
	Command.withSubcommands([classifyCmd]),
	Command.withDescription(
		"Deterministic fail-closed trivial-diff classifier (ADR 0120 §1, epic #1527)",
	),
);
