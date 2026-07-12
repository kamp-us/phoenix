#!/usr/bin/env node
/**
 * `gh-phoenix` CLI — the operable surface for issue #743. Two roles, dispatched
 * on the first argument:
 *
 *   - `gh-phoenix lint-skills <file>...` — run the skill lint (the pure `lintCorpus`
 *     core: GraphQL-path `gh` calls + invalid YAML frontmatter, #743/#1766) over the
 *     handed files, emit each check's scanned scope, and FAIL CLOSED (exit 3) on zero
 *     scope in either check per ADR 0092; exit 2 on any finding, 0 clean.
 *
 *   - `gh-phoenix <any other gh args>` — the `gh` SHIM. When this binary shadows
 *     `gh` on the subagent PATH (as `gh`, symlinked/wrapped to here), it routes
 *     the argv through the pure `route` core and then either execs the real `gh`
 *     (passthrough/rewrite) or fails fast with a REST hint (block). The real `gh`
 *     is resolved via `$GH_PHOENIX_REAL_GH` or the first PATH `gh` that isn't
 *     this shim — so the shim never recurses into itself.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/leak-guard` /
 * `@kampus/epic-ledger`): `effect/unstable/cli` for the lint subcommand's
 * variadic file argument, the Node platform over `NodeServices.layer`, run via
 * `NodeRuntime.runMain`. The `gh` shim path is a plain Node exec (it must
 * transparently inherit stdio and the real `gh`'s exit code), so it short-circuits
 * before the Effect CLI runtime.
 */
import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect} from "effect";
import * as Schema from "effect/Schema";
import {Argument, Command} from "effect/unstable/cli";
import {isZeroScope, lintCorpus, type ScanFile} from "./lint.ts";
import {fileExists, resolveRealGh, resolveRepo} from "./resolve.ts";
import {route} from "./router.ts";

const FINDING_EXIT_CODE = 2;
const ZERO_SCOPE_EXIT_CODE = 3;

// ── The `gh` shim path (short-circuits before the Effect CLI) ──────────────────

/**
 * Run the `gh` shim over `argv` (the args after the binary name). Execs the real
 * `gh` for passthrough/rewrite (inheriting stdio + exit code) or exits non-zero
 * with a REST hint for a block. Never returns for a real exec — it `process.exit`s
 * with the child's code.
 */
const runShim = (argv: ReadonlyArray<string>): never => {
	const realGh = resolveRealGh();
	const repo = resolveRepo(realGh);
	const decision = route(argv, {repo, bodyFileExists: fileExists});

	if (decision.kind === "block") {
		process.stderr.write(`gh-phoenix: blocked — ${decision.reason}\n  hint: ${decision.hint}\n`);
		process.exit(1);
	}

	if (decision.kind === "rewrite") {
		process.stderr.write(`gh-phoenix: ${decision.reason}\n`);
		if (decision.stripped.length > 0) {
			process.stderr.write(
				`gh-phoenix: stripped (Projects-classic/GraphQL-only): ${decision.stripped.join(", ")}\n`,
			);
		}
	}

	if (realGh === null) {
		process.stderr.write(
			"gh-phoenix: no real `gh` found on PATH (set $GH_PHOENIX_REAL_GH). Cannot forward.\n",
		);
		process.exit(127);
	}

	const result = spawnSync(realGh, [...decision.argv], {stdio: "inherit"});
	process.exit(result.status ?? 1);
};

// ── The `lint-skills` subcommand (the Effect CLI surface) ──────────────────────

class FindingsFound extends Schema.TaggedErrorClass<FindingsFound>()(
	"@kampus/gh-phoenix/FindingsFound",
	{count: Schema.Number},
) {}
class ZeroScope extends Schema.TaggedErrorClass<ZeroScope>()("@kampus/gh-phoenix/ZeroScope", {}) {}

const readFileOrSkip = (file: string): Effect.Effect<string | null> =>
	Effect.try(() => readFileSync(file, "utf8")).pipe(Effect.orElseSucceed(() => null));

const fileArg = Argument.string("file").pipe(
	Argument.atLeast(1),
	Argument.withDescription(
		"one or more skill-corpus file paths to lint for GraphQL-path gh calls and invalid YAML frontmatter",
	),
);

const lintSkills = Command.make(
	"lint-skills",
	{files: fileArg},
	Effect.fn(function* ({files}) {
		const scanInput: ScanFile[] = [];
		for (const file of files) {
			const content = yield* readFileOrSkip(file);
			if (content !== null) scanInput.push({file, content});
		}

		const result = lintCorpus(scanInput);

		// ADR 0092: emit what each check scanned (scope is observable), THEN judge.
		yield* Console.log(
			`gh-phoenix lint-skills: gh-call scan scanned ${result.scanned.length} file(s)` +
				(result.scanned.length > 0 ? `:` : ` (zero scope)`),
		);
		for (const f of result.scanned) yield* Console.log(`  scanned: ${f}`);
		yield* Console.log(
			`gh-phoenix lint-skills: frontmatter check scanned ${result.frontmatterScanned.length} file(s)` +
				(result.frontmatterScanned.length > 0 ? `:` : ` (zero scope)`),
		);
		for (const f of result.frontmatterScanned) yield* Console.log(`  frontmatter-scanned: ${f}`);

		// ADR 0092: zero scope in EITHER check is a FAIL, never a silent PASS.
		if (isZeroScope(result)) {
			yield* Console.error(
				"gh-phoenix lint-skills: FAIL — scanned zero files (zero-scope fail-closed, ADR 0092).",
			);
			return yield* Effect.fail(new ZeroScope());
		}

		const total = result.findings.length + result.frontmatterFindings.length;
		if (total === 0) {
			yield* Console.log(
				"gh-phoenix lint-skills: clean — no GraphQL-path gh calls and all frontmatter parses as strict YAML.",
			);
			return;
		}

		if (result.findings.length > 0) {
			yield* Console.error(
				`gh-phoenix lint-skills: FAIL — ${result.findings.length} GraphQL-path gh call(s) in the skill corpus (REST-only on this org, #743):`,
			);
			for (const f of result.findings) {
				yield* Console.error(`  ${f.file}:${f.line}: ${f.matched} — ${f.reason}`);
			}
		}

		if (result.frontmatterFindings.length > 0) {
			yield* Console.error(
				`gh-phoenix lint-skills: FAIL — ${result.frontmatterFindings.length} file(s) with invalid YAML frontmatter (a mid-sentence colon-space in an unquoted scalar reparses as a mapping; quote the value or use a block scalar — #1766):`,
			);
			for (const f of result.frontmatterFindings) {
				yield* Console.error(`  ${f.file}: ${f.reason}`);
			}
		}

		return yield* Effect.fail(new FindingsFound({count: total}));
	}),
).pipe(
	Command.withDescription(
		"Lint the skill corpus for GraphQL-path gh invocations (fails closed on zero scope)",
	),
);

const cli = Command.make("gh-phoenix").pipe(
	Command.withSubcommands([lintSkills]),
	Command.withDescription("gh REST shim + skill grep-lint vs Projects-classic GraphQL (#743)"),
);

// Dispatch: `lint-skills` → the Effect CLI; anything else → the gh shim. An empty
// argv (bare `gh-phoenix`) falls to the CLI so `--help` / `--version` work.
const sub = process.argv[2];
if (sub !== undefined && sub !== "lint-skills" && !sub.startsWith("-")) {
	runShim(process.argv.slice(2));
} else {
	cli.pipe(
		Command.run({version: "0.0.0"}),
		Effect.catchTag("@kampus/gh-phoenix/ZeroScope", () =>
			Effect.sync(() => process.exit(ZERO_SCOPE_EXIT_CODE)),
		),
		Effect.catchTag("@kampus/gh-phoenix/FindingsFound", () =>
			Effect.sync(() => process.exit(FINDING_EXIT_CODE)),
		),
		Effect.provide(NodeServices.layer),
		NodeRuntime.runMain,
	);
}
