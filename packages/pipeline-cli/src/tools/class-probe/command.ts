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
 * single source — never a third inline copy) plus the additive `UI_RE` from the local
 * `ship-it/SKILL.md` (its single source), and prints one present class per line to **stdout**
 * — appending `has-ui` when the diff is UI-affecting (`--namespaces` prints the `review-*` set
 * instead, appending `review-design`). Folding has-ui in here is the #2485/#2483 fix: the
 * reviewer fan dispatches review-design deterministically off this output instead of eyeballing
 * a non-visual `apps/web/src/*.ts` away and deadlocking ship-it on an empty review-design
 * namespace. A human summary goes to **stderr**; exit is always 0 — this classifies, it does
 * not gate.
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
import {
	classify,
	DESIGN_NAMESPACE,
	isUiAffecting,
	NO_INPUT_FAILCLOSED_CLASSES,
	parseClassProbes,
	parseUiExclude,
	parseUiProbe,
	requiredNamespaces,
} from "./class-probe.ts";

const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

/** The single source for the additive `UI_RE` (has-ui → review-design), read locally like §CLASS. */
const SHIP_IT_PATH = "claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md";

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
	// biome-ignore lint/plugin: best-effort read — an empty/failed read is absorbed into no files ([]), never the E channel; a total helper, not Effect-cosplay.
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
	// biome-ignore lint/plugin: best-effort read — an unreadable file is absorbed into null (⇒ fail-closed probes), never the E channel; a total helper, not Effect-cosplay.
	try {
		return readFileSync(join(root, FORMATS_PATH), "utf8");
	} catch {
		return null;
	}
};

/** Read local ship-it/SKILL.md text; null (⇒ fail-closed `UI_RE`) if the file is unreadable. */
const readShipIt = (root: string): string | null => {
	// biome-ignore lint/plugin: best-effort read — an unreadable file is absorbed into null (⇒ fail-closed UI_RE), never the E channel; a total helper, not Effect-cosplay.
	try {
		return readFileSync(join(root, SHIP_IT_PATH), "utf8");
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
		const shipIt = readShipIt(rootDir);
		const uiRe = parseUiProbe(shipIt ?? "");
		const uiExclude = parseUiExclude(shipIt ?? "");
		const files = readFiles(filesFrom);
		// Fail closed on zero input (#3786): this probe is only ever piped a PR's changed-file
		// list, which is never legitimately empty — an empty read is a dropped/undelivered stdin,
		// indistinguishable at the pure core from a gate-free PR. Route it through the same has-code
		// path an unclassified file rides (NO_INPUT_FAILCLOSED_CLASSES) so a dropped stdin can never
		// yield an empty required-gate set; a distinct loud stderr line below makes the drop visible
		// at the point it happens rather than silently reading as "this PR requires no gates".
		const noInput = files.length === 0;
		const classes = noInput ? NO_INPUT_FAILCLOSED_CLASSES : classify(files, probes);
		const uiAffecting = isUiAffecting(files, uiRe, uiExclude);

		if (formats === null) {
			yield* Effect.sync(() =>
				process.stderr.write(
					`class-probe: could not read ${FORMATS_PATH} under ${rootDir} — using fail-closed probes (dispatch every gate).\n`,
				),
			);
		}
		if (shipIt === null) {
			yield* Effect.sync(() =>
				process.stderr.write(
					`class-probe: could not read ${SHIP_IT_PATH} under ${rootDir} — using fail-closed UI_RE (require review-design).\n`,
				),
			);
		}
		if (noInput) {
			yield* Effect.sync(() =>
				process.stderr.write(
					"class-probe: read 0 files (empty or undelivered stdin/--files-from) — failing closed to has-code (review-code). This probe is only ever piped a PR's changed files, which is never legitimately empty; an empty read is a dropped stdin, not a gate-free PR (#3786).\n",
				),
			);
		}
		yield* Effect.sync(() =>
			process.stderr.write(
				`class-probe: ${files.length} changed file(s) → ${classes.length > 0 ? classes.join(", ") : "no artifact class"}${uiAffecting ? " + has-ui (review-design)" : ""}\n`,
			),
		);

		const base = namespaces ? requiredNamespaces(classes) : classes;
		const out = uiAffecting ? [...base, namespaces ? DESIGN_NAMESPACE : "has-ui"] : base;
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
