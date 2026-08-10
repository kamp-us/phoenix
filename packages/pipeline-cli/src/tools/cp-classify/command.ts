/**
 * The `cp-classify` tool — `pipeline-cli cp-classify classify [flags]` (issue #4161).
 *
 *   gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" --jq '.[].filename' \
 *     | pipeline-cli cp-classify classify --repo "$REPO"
 *   pipeline-cli cp-classify classify --files-file changed.txt --control-plane-re "$CONTROL_PLANE_RE"
 *
 * The §CP entry point that **cannot return a fail-open "not control plane"**. Reads a changed-file
 * list (stdin, one path per line, or `--files-file`), resolves the live `CONTROL_PLANE_RE` from
 * `origin/main` (never an in-tree snapshot — #981), and prints ONE of four state words to
 * **stdout**: `control-plane` / `content-undetermined` / `not-control-plane` / `unknown`. The
 * human reason (and, for `content-undetermined`, the ADRs still owed a content probe) goes to
 * **stderr**. The predicate itself is the pure core in `cp-classify.ts`.
 *
 * **Exit code:** 0 on every hold state, and {@link NOT_CONTROL_PLANE_EXIT_CODE} (3) — a code no
 * failure-to-run produces — on the one proven-ordinary verdict. The exit code discriminates the
 * four states ONLY ONCE THE VERB HAS RUN; it says nothing about whether it ran, so a caller must
 * assert on the stdout state word (`[ "$CP_STATE" = "not-control-plane" ]`), never on mere
 * non-zero. `… || ordinary` is UNSAFE: it fires on a malformed invocation (4) and a missing binary
 * (127) alike. See the README's "How to call this safely" for the observed failure modes.
 *
 * `content-undetermined` is an OBLIGATION, not a verdict: resolve it by running the existing
 * `guard-content-probe` verb over each listed `.decisions/**` file at the PR head (ADR 0164). It is
 * deliberately not a §CP answer, so this verb widens no over-match (#2617).
 */
import {execFileSync} from "node:child_process";
import {Console, Effect, FileSystem, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {PROVEN_ORDINARY_EXIT_CODE} from "../../exit-codes.ts";
import {readStdinTextOrExit} from "../../read-stdin.ts";
import {extractControlPlaneRe} from "../codeowners-cp/codeowners-cp.ts";
import {FORMATS_PATH} from "../codeowners-cp/gate.ts";
import {type CpClassification, classifyControlPlane, isHold} from "./cp-classify.ts";

/** The proven-ordinary verdict's own exit code — the shared rule, not a per-tool choice. */
export const NOT_CONTROL_PLANE_EXIT_CODE = PROVEN_ORDINARY_EXIT_CODE;

const filesFileFlag = Flag.string("files-file").pipe(
	Flag.optional,
	Flag.withDescription("read the changed-file list from this file (default: stdin)"),
);

const controlPlaneReFlag = Flag.string("control-plane-re").pipe(
	Flag.optional,
	Flag.withDescription(
		"the live CONTROL_PLANE_RE to classify against (default: re-resolve from origin/main)",
	),
);

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"owner/repo to resolve the live CONTROL_PLANE_RE from (default: CLAUDE_PIPELINE_REPO / gh repo view)",
	),
);

/** Read the file list: `--files-file` over the `FileSystem` seam if given, else stdin. */
const readFileList = Effect.fn(function* (filesFile: Option.Option<string>) {
	if (Option.isSome(filesFile)) {
		const fs = yield* FileSystem.FileSystem;
		return yield* Effect.orElseSucceed(fs.readFileString(filesFile.value), () => null);
	}
	return yield* readStdinTextOrExit();
});

/** Resolve owner/repo: `--repo`, else `CLAUDE_PIPELINE_REPO`, else `gh repo view`. null on failure. */
const resolveRepo = (repo: Option.Option<string>): string | null => {
	const explicit = Option.getOrUndefined(repo) ?? process.env.CLAUDE_PIPELINE_REPO;
	if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
	// biome-ignore lint/plugin: best-effort probe — a failed gh repo view is absorbed into null (unresolved repo ⇒ `unknown`, fail-closed), never the E channel; a total helper, not Effect-cosplay.
	try {
		return execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return null;
	}
};

/**
 * The live §CP boundary from `origin/main` (`?ref=main`) — the anti-self-authorization read
 * (#981): a boundary-editing PR is classified against MAIN's boundary, never its own edit. Any
 * failure returns null, which the core resolves to `unknown` — never to a stale in-tree const.
 */
const fetchLiveControlPlaneRe = (repo: string | null): string | null => {
	if (repo === null) return null;
	// biome-ignore lint/plugin: best-effort probe — any failure (gh missing/unauth, repo unresolved, file absent) is absorbed into null (⇒ `unknown`, fail-closed), never the E channel; a total helper, not Effect-cosplay.
	try {
		const raw = execFileSync(
			"gh",
			[
				"api",
				`repos/${repo}/contents/${FORMATS_PATH}?ref=main`,
				"-H",
				"Accept: application/vnd.github.raw",
			],
			{encoding: "utf8"},
		);
		return extractControlPlaneRe(raw);
	} catch {
		return null;
	}
};

/** The stderr reason line — states the verdict, the evidence, and any obligation it leaves open. */
const reasonLine = (result: CpClassification): string => {
	switch (result.state) {
		case "control-plane":
			return `cp-classify: control-plane [${result.reason}] — ${result.matchedPath} matches the live CONTROL_PLANE_RE. BLOCKING (human merge).\n`;
		case "content-undetermined":
			return `cp-classify: content-undetermined [${result.reason}] — no path matched, but ${result.contentSources.length} .decisions/** file(s) can be §CP BY CONTENT (ADR 0164). NOT a non-§CP answer: run \`pipeline-cli guard-content-probe classify\` on each at the PR head before claiming ordinary:\n${result.contentSources.map((p) => `  ${p}\n`).join("")}`;
		case "not-control-plane":
			return `cp-classify: not-control-plane [${result.reason}] — no path matched the live CONTROL_PLANE_RE and no .decisions/** file is present, so the ADR-0164 content clause has nothing to decide. Proven ordinary.\n`;
		case "unknown":
			return `cp-classify: unknown [${result.reason}] — the classification could NOT be made. This is not "not control plane": treat as §CP and hold (ADR 0092, fail-closed).\n`;
	}
};

const classifyCmd = Command.make(
	"classify",
	{filesFile: filesFileFlag, controlPlaneRe: controlPlaneReFlag, repo: repoFlag},
	Effect.fn(function* ({filesFile, controlPlaneRe, repo}) {
		const boundary = Option.getOrElse(controlPlaneRe, () =>
			fetchLiveControlPlaneRe(resolveRepo(repo)),
		);
		const listText = yield* readFileList(filesFile);
		// An unreadable --files-file is null: classify an EMPTY set, which the core resolves to
		// `unknown`. A read that failed and a PR with no files are both un-decidable — neither is
		// evidence of ordinariness.
		const result = classifyControlPlane((listText ?? "").split("\n"), boundary);

		yield* Effect.sync(() => process.stderr.write(reasonLine(result)));
		yield* Console.log(result.state);
		if (!isHold(result.state))
			return yield* Effect.sync(() => process.exit(NOT_CONTROL_PLANE_EXIT_CODE));
	}),
).pipe(
	Command.withDescription(
		"Classify a changed-file set against the §CP boundary, four-state and fail-closed — a path-only answer can never read as non-§CP (#4161)",
	),
);

export const cpClassifyCommand = Command.make("cp-classify").pipe(
	Command.withSubcommands([classifyCmd]),
	Command.withDescription(
		"The §CP entry point that cannot return a fail-open 'not control plane' (path + ADR-0164 content axes; #4161)",
	),
);
