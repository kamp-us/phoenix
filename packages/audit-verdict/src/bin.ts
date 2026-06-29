/**
 * `audit-verdict archive` — the thin Effect CLI around the pure verdict core (#1516).
 *
 * Reads the union of the dimensions' findings (a JSON `{ dimensions: DimensionResult[] }`,
 * the explorer's raw output), builds one dated `Verdict`, and writes its JSON + Markdown
 * renderings to the repo-relative accumulating run log (`rite-audit/runs/`). The on-demand
 * entry point that triggers a real run and feeds this is #1517 — this bin is the archive
 * surface, callable standalone over a findings file.
 *
 *   node src/bin.ts archive --input <findings.json> --stage <s> --base-url <u> [--date <iso>] [--root <dir>]
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {archivePath} from "./archive.ts";
import {renderVerdictJson, renderVerdictMarkdown} from "./render.ts";
import type {DimensionResult} from "./schema.ts";
import {buildVerdict} from "./verdict.ts";

const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

const findRoot = (from: string): string => {
	let dir = resolve(from);
	for (;;) {
		if (ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return resolve(from);
		dir = parent;
	}
};

const inputFlag = Flag.string("input").pipe(
	Flag.withDescription("path to the dimensions JSON ({ dimensions: DimensionResult[] })"),
);
const stageFlag = Flag.string("stage").pipe(Flag.withDescription("the audited stage name"));
const baseUrlFlag = Flag.string("base-url").pipe(
	Flag.withDescription("the audited stage base URL"),
);
const dateFlag = Flag.string("date").pipe(
	Flag.optional,
	Flag.withDescription("ISO-8601 run timestamp (default: now)"),
);
const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription("repo root to write the run log under (default: walk up for one)"),
);

const archive = Command.make(
	"archive",
	{input: inputFlag, stage: stageFlag, baseUrl: baseUrlFlag, date: dateFlag, root: rootFlag},
	Effect.fn(function* ({input, stage, baseUrl, date, root}) {
		const parsed = JSON.parse(readFileSync(input, "utf8")) as {
			dimensions?: ReadonlyArray<DimensionResult>;
		};
		const dimensions = parsed.dimensions ?? [];
		const verdict = buildVerdict({
			date: Option.getOrElse(date, () => new Date().toISOString()),
			target: {stage, baseUrl},
			dimensions,
		});

		const repoRoot = Option.isSome(root) ? resolve(root.value) : findRoot(process.cwd());
		const jsonRel = archivePath(verdict, "json");
		const mdRel = archivePath(verdict, "md");
		mkdirSync(join(repoRoot, dirname(jsonRel)), {recursive: true});
		writeFileSync(join(repoRoot, jsonRel), renderVerdictJson(verdict));
		writeFileSync(join(repoRoot, mdRel), renderVerdictMarkdown(verdict));

		yield* Console.log(
			`audit-verdict: ${verdict.overall} — wrote ${jsonRel} + ${mdRel} (${verdict.perDimension.length} dimension(s), ${verdict.findings.length} finding(s))`,
		);
	}),
).pipe(
	Command.withDescription("Build + archive one dated verdict from a dimensions findings file"),
);

const cli = Command.make("audit-verdict").pipe(
	Command.withSubcommands([archive]),
	Command.withDescription(
		"Aggregate rite-audit dimension findings into a dated archived verdict (#1516)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
