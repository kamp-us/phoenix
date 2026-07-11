/**
 * The `class-probe` tool — `pipeline-cli class-probe classify [flags]` (#2434).
 *
 *   git diff --name-only origin/main... | pipeline-cli class-probe classify
 *   gh api --paginate repos/$REPO/pulls/$PR/files --jq '.[].filename' \
 *     | pipeline-cli class-probe classify        # the reviewer fan / ship-it Step 0 probe
 *   pipeline-cli class-probe classify --files-from changed.txt
 *   pipeline-cli class-probe classify --namespaces # print review-* namespaces, not classes
 *
 * The deterministic artifact-class probe both the reviewer fan and ship-it Step 0 run so
 * they cannot disagree on a diff's required class coverage (#2434, the `.glossary/**→has-code`
 * miss on PR #2430). Reads the changed-file list from stdin (or `--files-from`), reads the
 * four canonical `HAS_*_RE` probes from the local `gh-issue-intake-formats.md` §CLASS (the
 * single source — never a third inline copy), and prints one present class per line to
 * **stdout** (`--namespaces` prints the `review-*` set instead). A human summary goes to
 * **stderr**; exit is always 0 — this classifies, it does not gate.
 *
 * IO here (the thin bin), classification in `class-probe.ts` (the pure core). An
 * unreadable §CLASS falls back to the fail-closed probes (`FAILCLOSED_PROBES`), which
 * over-dispatch every gate rather than skip one.
 */
import {existsSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../../find-root-dir.ts";
import {FORMATS_PATH} from "../codeowners-cp/gate.ts";
import {classify, parseClassProbes, requiredNamespaces} from "./class-probe.ts";

const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

const defaultRoot = (from: string = process.cwd()): string => {
	const start = resolve(from);
	const root = findRootDir(
		start,
		(dir) => ROOT_MARKERS.some((marker) => existsSync(join(dir, marker))),
		dirname,
	);
	return root ?? start;
};

const filesFromFlag = Flag.string("files-from").pipe(
	Flag.optional,
	Flag.withDescription("read the changed-file list from this file (default: stdin)"),
);

const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription(
		"repo root to read gh-issue-intake-formats.md §CLASS from (default: walk up)",
	),
);

const namespacesFlag = Flag.boolean("namespaces").pipe(
	Flag.withDescription("print the required review-* namespaces instead of the has-* classes"),
);

/** Read the changed-file list from `--files-from` or stdin; empty/failed read ⇒ no files. */
const readFiles = (filesFrom: Option.Option<string>): ReadonlyArray<string> => {
	let raw: string;
	try {
		raw = Option.match(filesFrom, {
			onSome: (path) => readFileSync(path, "utf8"),
			onNone: () => readFileSync(0, "utf8"),
		});
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
};

/** Read local §CLASS text; null (⇒ fail-closed probes) if the file is unreadable. */
const readFormats = (root: string): string | null => {
	try {
		return readFileSync(join(root, FORMATS_PATH), "utf8");
	} catch {
		return null;
	}
};

const classifyCmd = Command.make(
	"classify",
	{filesFrom: filesFromFlag, root: rootFlag, namespaces: namespacesFlag},
	Effect.fn(function* ({filesFrom, root, namespaces}) {
		const rootDir = Option.getOrElse(root, () => defaultRoot());
		const formats = readFormats(rootDir);
		const probes = parseClassProbes(formats ?? "");
		const files = readFiles(filesFrom);
		const classes = classify(files, probes);

		if (formats === null) {
			yield* Effect.sync(() =>
				process.stderr.write(
					`class-probe: could not read ${FORMATS_PATH} under ${rootDir} — using fail-closed probes (dispatch every gate).\n`,
				),
			);
		}
		yield* Effect.sync(() =>
			process.stderr.write(
				`class-probe: ${files.length} changed file(s) → ${classes.length > 0 ? classes.join(", ") : "no artifact class"}\n`,
			),
		);

		const out = namespaces ? requiredNamespaces(classes) : classes;
		for (const line of out) {
			yield* Console.log(line);
		}
	}),
).pipe(
	Command.withDescription(
		"Classify a changed-file list into the has-* classes (or review-* namespaces) it spans (#2434)",
	),
);

export const classProbeCommand = Command.make("class-probe").pipe(
	Command.withSubcommands([classifyCmd]),
	Command.withDescription(
		"Deterministic artifact-class probe shared by the reviewer fan and ship-it Step 0 (#2434)",
	),
);
