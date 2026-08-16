/**
 * The `cli-invocation-guard` tool — `pipeline-cli cli-invocation-guard check|baseline <file>…`.
 *
 * Reds on any non-canonical invocation of either plugin CLI inside runnable shell in the plugin
 * corpus — a bare `pipeline-cli <verb>` (#3314), a bare `fabrika <verb>` (#5679), or a cwd-relative
 * `node …/src/bin.ts <verb>` of either (#4236) — across **both** corpus surfaces: a runnable
 * fence in a `.md`, and a `.sh` file scanned whole as one implicit fence (#4486). Each CLI's
 * canonical resolution is documented in its own home, and the remedy printed below names it.
 * Follows the `adoption-lint` / `gh-phoenix lint-skills` shape — an IO-free core over
 * handed-in file contents, with a thin CLI that maps the verdict to a fail-closed exit contract
 * (ADR 0092):
 *
 *   exit 0 — clean (no non-canonical invocation attributable to this scan)
 *   exit 2 — one or more attributable non-canonical invocations
 *   exit 3 — zero scope on any axis (no file scanned, no runnable `.md` fence, no `.sh` file, or
 *            an unusable baseline)
 *
 * `baseline` emits the same scan as JSON for a later `check --baseline` to diff against; it is
 * the merge-base half of the attribution split (#4250). It exits 0 on findings on purpose — a
 * dirty base is the input to attribution, not a verdict about it — but still exits 3 on a zero
 * scope, so a broken base-side scan reds instead of passing as "nothing pre-existing".
 */
import {readFileSync, writeFileSync} from "node:fs";
import {Console, Effect, Option, Result} from "effect";
import * as Schema from "effect/Schema";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {
	type AttributedFinding,
	attribute,
	type Cli,
	type GuardResult,
	isUsableBaseline,
	isZeroScope,
	parseBaseline,
	type ScanFile,
	scanCorpus,
} from "./cli-invocation-guard.ts";

const FINDING_EXIT_CODE = 2;
const ZERO_SCOPE_EXIT_CODE = 3;

/**
 * One remedy per CLI, because the two resolve by opposite mechanisms and a shared line would send
 * half the readers to the wrong fix (#5679).
 */
const FIX_ATTRIBUTABLE: Record<Cli, string> = {
	"pipeline-cli":
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in the remediation literal a reader pastes, not a JS template
		'  FIX (NEW — yours to edit, `pipeline-cli`): resolve the shim once per fence — PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel)/claude-plugins/kampus-pipeline}/bin/pipeline-cli" — then call "$PCLI" <verb>. See §CLI in claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md.',
	fabrika:
		"  FIX (NEW — yours to edit, `fabrika`): write `pnpm exec fabrika <group> <verb> …`. It resolves through the calling tree's own node_modules/.bin from any directory inside it; the bare name resolves whatever copy PATH points at, which in a worktree is another checkout and refuses at exit 126. See rule 5 in claude-plugins/fabrika/docs/cli-interface-convention.md.",
};

const FIX_PRE_EXISTING =
	"  FIX (PRE-EXISTING — not yours to edit): the offender was already at the merge-base. The remedy is a REBASE onto a `main` where it is fixed, not an edit — editing it here puts an unrelated change in your diff (#4250).";

class FindingsFound extends Schema.TaggedErrorClass<FindingsFound>()("FindingsFound", {
	count: Schema.Number,
}) {}
class ZeroScope extends Schema.TaggedErrorClass<ZeroScope>()("ZeroScope", {}) {}

const readFileOrSkip = (file: string): string | null =>
	Result.getOrElse(
		Result.try(() => readFileSync(file, "utf8")),
		() => null,
	);

const fileArg = Argument.string("file").pipe(
	Argument.atLeast(1),
	Argument.withDescription(
		"one or more corpus file paths (SKILL.md / agent defs / plugin docs / extracted `scripts/*.sh`) to scan for non-canonical `pipeline-cli` or `fabrika` invocations",
	),
);

const scan = (files: ReadonlyArray<string>): GuardResult => {
	const scanInput: ScanFile[] = [];
	for (const file of files) {
		const content = readFileOrSkip(file);
		if (content !== null) scanInput.push({file, content});
	}
	return scanCorpus(scanInput);
};

/** One number per surface, so a collapsed surface is legible instead of hiding inside a total. */
const emitScope = (result: GuardResult, label: string): Effect.Effect<void> =>
	Console.log(
		`cli-invocation-guard: ${label} scanned ${result.scanned.length} file(s), ${result.fenceCount} runnable bash/sh fence(s) in markdown, ${result.shellFileCount} shell file(s) as implicit fences`,
	);

const readBaseline = (path: string): Effect.Effect<GuardResult, ZeroScope> =>
	Effect.gen(function* () {
		const raw = readFileOrSkip(path);
		const baseline = raw === null ? null : parseBaseline(raw);
		if (baseline === null) {
			yield* Console.error(
				`cli-invocation-guard: FAIL — the merge-base baseline at '${path}' is missing, unreadable, or missing a scope axis. A base-side scan that did not produce a well-formed manifest is a BROKEN baseline, and a broken baseline must never read as "no pre-existing violations" (ADR 0092; #4250, #4486).`,
			);
			return yield* Effect.fail(new ZeroScope());
		}
		if (!isUsableBaseline(baseline)) {
			yield* Console.error(
				`cli-invocation-guard: FAIL — the merge-base baseline at '${path}' has zero scope on some axis (${baseline.scanned.length} file(s), ${baseline.fenceCount} runnable fence(s) in markdown, ${baseline.shellFileCount} shell file(s)). A base scan that saw nothing on a surface cannot be diffed against (ADR 0092; #4250, #4486).`,
			);
			return yield* Effect.fail(new ZeroScope());
		}
		yield* Console.log(
			`cli-invocation-guard: baseline loaded — ${baseline.findings.length} violation(s) already present at the merge-base across ${baseline.scanned.length} file(s)`,
		);
		return baseline;
	});

/** `--baseline` absent ⇒ no attribution (fail on any violation); present ⇒ read it or red. */
const loadBaseline = (
	path: Option.Option<string>,
): Effect.Effect<Option.Option<GuardResult>, ZeroScope> =>
	Option.match(path, {
		onNone: () => Effect.succeed(Option.none()),
		onSome: (p) => Effect.map(readBaseline(p), Option.some),
	});

const reportFinding = (f: AttributedFinding): Effect.Effect<void> =>
	Console.error(
		`  [${f.attribution === "new" ? "NEW — introduced by this change" : "PRE-EXISTING at the merge-base"}] [${f.cli}] ${f.file}:${f.line}: ${f.text}`,
	);

const guardZeroScope = (result: GuardResult): Effect.Effect<void, ZeroScope> =>
	Effect.gen(function* () {
		if (!isZeroScope(result)) return;
		yield* Console.error(
			`cli-invocation-guard: FAIL — scanned ${result.scanned.length} file(s): ${result.fenceCount} runnable fence(s) in markdown, ${result.shellFileCount} shell file(s); a zero scope on ANY axis is fail-closed, per surface (ADR 0092, #4486).`,
		);
		return yield* Effect.fail(new ZeroScope());
	});

/**
 * Judge a scan. With no baseline every violation is attributable (the `push: main` leg, where a
 * dirty tree must red whoever wrote it); with one, only the violations this head introduced
 * fail the build — but ALL of them are still reported, each labelled, so a reader can tell
 * whose defect it is off the check surface without opening the raw log (#4250).
 */
const judge = (
	result: GuardResult,
	baseline: Option.Option<GuardResult>,
): Effect.Effect<void, ZeroScope | FindingsFound> =>
	Effect.gen(function* () {
		yield* guardZeroScope(result);

		const attributed = attribute(
			result.findings,
			Option.match(baseline, {onNone: () => [], onSome: (b) => b.findings}),
		);
		const attributable = attributed.filter((f) => f.attribution === "new");
		const preExisting = attributed.filter((f) => f.attribution === "pre-existing");

		if (attributable.length === 0) {
			yield* Console.log(
				preExisting.length === 0
					? "cli-invocation-guard: clean — every `pipeline-cli` and `fabrika` call in runnable shell (fenced or `.sh`) uses that CLI's canonical resolution."
					: `cli-invocation-guard: clean — this change introduces no non-canonical invocation. ${preExisting.length} violation(s) are PRE-EXISTING at the merge-base and are NOT this change's to fix:`,
			);
			for (const f of preExisting) yield* reportFinding(f);
			if (preExisting.length > 0) yield* Console.log(FIX_PRE_EXISTING);
			return;
		}

		yield* Console.error(
			`cli-invocation-guard: FAIL — ${attributable.length} non-canonical invocation(s) in runnable shell attributable to this change${preExisting.length > 0 ? ` (plus ${preExisting.length} pre-existing at the merge-base, listed but not counted against you)` : ""}. A bare \`pipeline-cli\` is NOT on PATH where agents spawn (ADR 0207 retired PATH-shadowing) and dies \`command not found\` (exit 127); a bare \`fabrika\` IS on PATH but resolves whichever copy PATH names, and from a worktree that is another checkout, refused at exit 126 (#5679); a cwd-relative \`node …/src/bin.ts\` dies \`Cannot find module\` (exit 1, empty stdout) from any dir but the repo root. Each way a fail-closed wrapper turns the miss into a wrong verdict (#3314, #4236, #5679):`,
		);
		for (const f of attributed) yield* reportFinding(f);
		for (const cli of new Set(attributable.map((f) => f.cli))) {
			yield* Console.error(FIX_ATTRIBUTABLE[cli]);
		}
		if (preExisting.length > 0) yield* Console.error(FIX_PRE_EXISTING);
		return yield* Effect.fail(new FindingsFound({count: attributable.length}));
	});

const onZeroScope = (_e: ZeroScope) => Effect.sync(() => process.exit(ZERO_SCOPE_EXIT_CODE));
const onFindingsFound = (_e: FindingsFound) => Effect.sync(() => process.exit(FINDING_EXIT_CODE));

const baselineFlag = Flag.string("baseline").pipe(
	Flag.optional,
	Flag.withDescription(
		"path to a `cli-invocation-guard baseline` manifest for the merge-base; with it, only violations NOT present at the base fail the build (the pull_request leg). Omit it to fail on ANY violation (the push: main leg).",
	),
);

const outFlag = Flag.string("out").pipe(
	Flag.withDescription("path to write the merge-base scan manifest to (JSON)"),
);

const check = Command.make(
	"check",
	{files: fileArg, baseline: baselineFlag},
	Effect.fn(function* ({files, baseline: baselinePath}) {
		const result = scan(files);

		// ADR 0092: emit the scanned scope before judging it.
		yield* emitScope(result, "head —");

		const loaded = yield* loadBaseline(baselinePath).pipe(
			Effect.catchTag("ZeroScope", onZeroScope),
		);

		yield* judge(result, loaded).pipe(
			Effect.catchTag("ZeroScope", onZeroScope),
			Effect.catchTag("FindingsFound", onFindingsFound),
		);
	}),
).pipe(
	Command.withDescription(
		"Red on any non-canonical `pipeline-cli` or `fabrika` invocation in runnable shell — a bash/sh fence or a whole `.sh` file (fails closed on zero scope, per surface; --baseline narrows the verdict to newly-introduced ones)",
	),
);

const baseline = Command.make(
	"baseline",
	{files: fileArg, out: outFlag},
	Effect.fn(function* ({files, out}) {
		const result = scan(files);
		yield* emitScope(result, "merge-base —");
		// A dirty base is the INPUT to attribution, not a verdict about it, so findings here are
		// recorded rather than judged. A zero scope is a different animal — the scan is broken, so
		// it reds and the head-side `check --baseline` never runs against a phantom manifest.
		yield* guardZeroScope(result).pipe(Effect.catchTag("ZeroScope", onZeroScope));
		yield* Console.log(
			`cli-invocation-guard: ${result.findings.length} pre-existing violation(s) recorded at the merge-base`,
		);
		yield* Effect.sync(() => writeFileSync(out, `${JSON.stringify(result, null, "\t")}\n`));
		yield* Console.log(`cli-invocation-guard: merge-base manifest written to ${out}`);
	}),
).pipe(
	Command.withDescription(
		"Emit the merge-base scan as a JSON manifest for a later `check --baseline` to attribute against (exit 0 on findings, 3 on zero scope)",
	),
);

export const cliInvocationGuardCommand = Command.make("cli-invocation-guard").pipe(
	Command.withSubcommands([check, baseline]),
	Command.withDescription(
		"Enforce each plugin CLI's canonical resolution in the corpus: `pipeline-cli` by shim path (#3314), `fabrika` through `pnpm exec` (#5679)",
	),
);
