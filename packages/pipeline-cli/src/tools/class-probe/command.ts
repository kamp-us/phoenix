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
import {readFileSync} from "node:fs";
import {Console, Effect, FileSystem, Option, Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
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

// Walk up from cwd for the first ancestor bearing a repo-root marker, probing each marker
// through the `FileSystem`/`Path` seam so the resolver is testable off real disk
// (.patterns/effect-platform-access.md). Mirrors `findRootDir`'s pure upward walk (dirname to
// the fixpoint, then fall back to the start), but the marker check is the fs seam — `fs.exists`
// yields an Effect. Marker-existence faults fall through as false, matching `existsSync`.
const defaultRoot = Effect.fn(function* (from: string = process.cwd()) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const start = path.resolve(from);
	let dir = start;
	for (;;) {
		for (const marker of ROOT_MARKERS) {
			if (yield* fs.exists(path.join(dir, marker)).pipe(Effect.orElseSucceed(() => false)))
				return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
});

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
const readFiles = (
	filesFrom: Option.Option<string>,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const raw = yield* Option.match(filesFrom, {
			onSome: (path) =>
				Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path, "utf8")).pipe(
					Effect.orElseSucceed(() => ""),
				),
			// stdin (fd 0): a node-only boundary — FileSystem exposes no stdin reader, so kept raw. A
			// failed/empty read is absorbed into no files (""), never the E channel; a total helper.
			onNone: () =>
				Effect.sync(() => {
					// biome-ignore lint/plugin: fd-0 boundary read (closed/empty stdin), absorbed to "" — not Effect-cosplay.
					try {
						return readFileSync(0, "utf8");
					} catch {
						return "";
					}
				}),
		});
		return raw
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	});

/** Read local §CLASS text; null (⇒ fail-closed probes) if the file is unreadable. */
const readFormats = (
	root: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		return yield* fs
			.readFileString(path.join(root, FORMATS_PATH), "utf8")
			.pipe(Effect.orElseSucceed(() => null));
	});

/** Read local ship-it/SKILL.md text; null (⇒ fail-closed `UI_RE`) if the file is unreadable. */
const readShipIt = (
	root: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		return yield* fs
			.readFileString(path.join(root, SHIP_IT_PATH), "utf8")
			.pipe(Effect.orElseSucceed(() => null));
	});

const classifyCmd = Command.make(
	"classify",
	{filesFrom: filesFromFlag, root: rootFlag, namespaces: namespacesFlag},
	Effect.fn(function* ({filesFrom, root, namespaces}) {
		const rootDir = yield* Option.match(root, {
			onNone: () => defaultRoot(),
			onSome: Effect.succeed,
		});
		const formats = yield* readFormats(rootDir);
		const probes = parseClassProbes(formats ?? "");
		const shipIt = yield* readShipIt(rootDir);
		const uiRe = parseUiProbe(shipIt ?? "");
		const uiExclude = parseUiExclude(shipIt ?? "");
		const files = yield* readFiles(filesFrom);
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
