#!/usr/bin/env node
/**
 * `gh-phoenix` CLI — the operable surface for issue #743. Two roles, dispatched
 * on the first argument:
 *
 *   - `gh-phoenix lint-skills <file>...` — run the skill grep-lint (the pure
 *     `lintCorpus` core) over the handed files, emit the scanned scope, and FAIL
 *     CLOSED (exit 3) on zero scope per ADR 0092; exit 2 on any finding, 0 clean.
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
import {execFileSync, spawnSync} from "node:child_process";
import {accessSync, constants, readFileSync, realpathSync} from "node:fs";
import {delimiter, join} from "node:path";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Data, Effect} from "effect";
import {Argument, Command} from "effect/unstable/cli";
import {isZeroScope, lintCorpus, type ScanFile} from "./lint.ts";
import {route} from "./router.ts";

const FINDING_EXIT_CODE = 2;
const ZERO_SCOPE_EXIT_CODE = 3;

// ── The `gh` shim path (short-circuits before the Effect CLI) ──────────────────

/** This binary's own resolved path, so PATH resolution can skip it (no self-recursion). */
const selfPath = (() => {
	try {
		return realpathSync(process.argv[1] ?? "");
	} catch {
		return process.argv[1] ?? "";
	}
})();

/**
 * Resolve the REAL `gh` to exec: `$GH_PHOENIX_REAL_GH` if set, else the first
 * executable `gh` on PATH whose realpath differs from this shim's. Returns null
 * when no real `gh` exists — the shim then can't passthrough and reports that.
 */
const resolveRealGh = (): string | null => {
	const explicit = process.env.GH_PHOENIX_REAL_GH;
	if (explicit && isExecutable(explicit)) return explicit;
	const dirs = (process.env.PATH ?? "").split(delimiter).filter((d) => d.length > 0);
	for (const dir of dirs) {
		const candidate = join(dir, "gh");
		if (!isExecutable(candidate)) continue;
		let resolved = candidate;
		try {
			resolved = realpathSync(candidate);
		} catch {
			/* use unresolved */
		}
		if (resolved !== selfPath) return candidate;
	}
	return null;
};

const isExecutable = (path: string): boolean => {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

const fileExists = (path: string): boolean => {
	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
};

/** Resolve `$CLAUDE_PIPELINE_REPO` or `gh repo view` — the repo the REST rewrites target. */
const resolveRepo = (realGh: string | null): string => {
	const fromEnv = process.env.CLAUDE_PIPELINE_REPO;
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	if (realGh) {
		try {
			return execFileSync(
				realGh,
				["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
				{
					encoding: "utf8",
				},
			).trim();
		} catch {
			/* fall through */
		}
	}
	return "kamp-us/phoenix";
};

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

class FindingsFound extends Data.TaggedError("FindingsFound")<{readonly count: number}> {}
class ZeroScope extends Data.TaggedError("ZeroScope")<{}> {}

const readFileOrSkip = (file: string): string | null => {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
};

const fileArg = Argument.string("file").pipe(
	Argument.atLeast(1),
	Argument.withDescription("one or more skill-corpus file paths to lint for GraphQL-path gh calls"),
);

const lintSkills = Command.make(
	"lint-skills",
	{files: fileArg},
	Effect.fn(function* ({files}) {
		const scanInput: ScanFile[] = [];
		for (const file of files) {
			const content = readFileOrSkip(file);
			if (content !== null) scanInput.push({file, content});
		}

		const result = lintCorpus(scanInput);

		// ADR 0092: emit what was scanned (scope is observable), THEN judge.
		yield* Console.log(
			`gh-phoenix lint-skills: scanned ${result.scanned.length} file(s)` +
				(result.scanned.length > 0 ? `:` : ` (zero scope)`),
		);
		for (const f of result.scanned) yield* Console.log(`  scanned: ${f}`);

		// ADR 0092: zero scope is a FAIL, never a silent PASS.
		if (isZeroScope(result)) {
			yield* Console.error(
				"gh-phoenix lint-skills: FAIL — scanned zero files (zero-scope fail-closed, ADR 0092).",
			);
			return yield* Effect.fail(new ZeroScope());
		}

		if (result.findings.length === 0) {
			yield* Console.log(
				"gh-phoenix lint-skills: clean — no GraphQL-path gh calls in the scanned skill corpus.",
			);
			return;
		}

		yield* Console.error(
			`gh-phoenix lint-skills: FAIL — ${result.findings.length} GraphQL-path gh call(s) in the skill corpus (REST-only on this org, #743):`,
		);
		for (const f of result.findings) {
			yield* Console.error(`  ${f.file}:${f.line}: ${f.matched} — ${f.reason}`);
		}
		return yield* Effect.fail(new FindingsFound({count: result.findings.length}));
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
		Effect.catchTag("ZeroScope", () => Effect.sync(() => process.exit(ZERO_SCOPE_EXIT_CODE))),
		Effect.catchTag("FindingsFound", () => Effect.sync(() => process.exit(FINDING_EXIT_CODE))),
		Effect.provide(NodeServices.layer),
		NodeRuntime.runMain,
	);
}
