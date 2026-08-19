/**
 * `build check` — this surface's validators, run in this tree, with the build cache **bypassed**.
 *
 * The bypass is the design, not an option. A cache hit from another checkout returned another tree's
 * green three times in one session (#4106) and recurred on the review side (#4887); re-running is
 * cheaper than trusting a key that has already lied. And the command set is the verb's, not the
 * agent's memory: v1 mandated the exact CI commands in prose with nothing enforcing it
 * (`SKILL.md:895-935`).
 *
 * **This verb predicts; the gate decides.** `ci.yml` owns redness, and where the two disagree the
 * gate's answer supersedes this one (interface convention rule 6). Nothing here re-reads CI.
 *
 * `--surface` is an **anchor, not a second classifier**: naming the surface is a judgement the skill
 * makes reading the issue, and a verb that guessed it from file extensions would be wrong exactly on
 * the mixed diffs where the answer matters. The verb takes the skill's answer and refuses one the diff
 * provably contradicts.
 *
 * **Green means "the validators ran and passed", never "I could not tell."** See {@link classifyDiff}
 * for the unvalidatable file class that keeps that distinction representable (#5229), and
 * {@link notCoveredBy} for the per-surface coverage the green's `unvalidated` list reports (#5288),
 * and {@link readMarkdown} for the file the verb could not open (#5304).
 */
import {Effect, FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {execCapture, execStatus} from "../io/exec.ts";
import {type Argv, CONFIG_PATH, readDocLeakExempt, readWorkflowValidators} from "../repo-config.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {requireSession} from "./claim.ts";
import {
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	UNCLASSIFIED_DIFF,
	VALIDATION_RED,
	ZERO_SCOPE,
} from "./codes.ts";
import {predecessorsOf, readTopology, renderRef, sameRef} from "./dependencies.ts";
import {docLeaks} from "./doc-leaks.ts";
import {changedFiles, mergeBase} from "./git.ts";
import {defaultBranch} from "./github.ts";
import {requireLane} from "./lane-guard.ts";
import {resolveTargetRepo} from "./target.ts";

const VERB = "build check";

export const SURFACES = ["code", "prose", "plan", "workflows"] as const;
export type Surface = (typeof SURFACES)[number];

const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json)$/;
const MARKDOWN_RE = /\.mdx?$/;
/** GitHub reads workflows from this directory and no deeper, so neither does the class. */
const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** The workflow linter, run over the changed workflow files when the tree has one. */
const ACTIONLINT = "actionlint";

/** The exact CI commands, cache-bypassed. `--force` is turbo's; `lint:worktree` has no cache to hit. */
const CODE_RUNNERS: ReadonlyArray<{readonly label: string; readonly argv: ReadonlyArray<string>}> =
	[
		{label: "pnpm typecheck --force", argv: ["typecheck", "--force"]},
		{label: "pnpm lint:worktree", argv: ["lint:worktree"]},
	];

export interface CheckOptions {
	readonly surface: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The changed files split by class, with `unvalidatable` the file class **no** surface validates.
 *
 * That last bucket is the point. Filtering with the extension patterns and reading nothing off what
 * fell out of all of them made "matched none" an absence, and an absence cannot be refused: a
 * `.yml`/`.sh` diff produced an empty markdown list, zero validator iterations and a green that had
 * opened no file (#5229). Named, it is a state the verb can act on.
 *
 * `workflows` was carved out of it later (#5991): the files under `.github/workflows/` are where the
 * repo's own gates live, they *do* have validators, and leaving them unvalidatable left a
 * workflows-only lane with no invocation that could go green at all.
 *
 * `unvalidatable` is a property of the **tree** — no surface covers these files. Whether *this* run
 * covered a file is a narrower question, and {@link notCoveredBy} is the one that answers it; the two
 * were the same word once, which is how a markdown file could sit outside a `--surface code` green's
 * disclosure while the field's own documentation said it listed everything the verdict missed (#5288).
 */
export interface DiffClasses {
	readonly code: ReadonlyArray<string>;
	readonly markdown: ReadonlyArray<string>;
	readonly workflows: ReadonlyArray<string>;
	readonly unvalidatable: ReadonlyArray<string>;
}

/**
 * Workflow YAML is its own class, not a widening of `code`: `pnpm typecheck` does not read it, and a
 * class is only sound while every validator its surface claims actually opens it (#5229, #5991).
 */
const classOf = (file: string): keyof DiffClasses => {
	if (WORKFLOW_RE.test(file)) return "workflows";
	if (CODE_RE.test(file)) return "code";
	if (MARKDOWN_RE.test(file)) return "markdown";
	return "unvalidatable";
};

export const classifyDiff = (files: ReadonlyArray<string>): DiffClasses => ({
	code: files.filter((f) => classOf(f) === "code"),
	markdown: files.filter((f) => classOf(f) === "markdown"),
	workflows: files.filter((f) => classOf(f) === "workflows"),
	unvalidatable: files.filter((f) => classOf(f) === "unvalidatable"),
});

/**
 * The file classes each surface's validators actually open. `unvalidatable` is in no surface's.
 *
 * Two surfaces claiming one class is only sound while both run **every** validator that class gets.
 * The markdown loop in {@link runCheck} is where that holds: it runs the leak scan and the link
 * resolver over every markdown file whatever the surface, and adds {@link PLAN_GRAMMAR} on top.
 * `plan` used to run the grammar *instead*, so a ledger greened with `unvalidated: []` while the
 * leak scan had never opened it — a disclosure true at the file-open level and false at the
 * validator level (#5304).
 */
const COVERS: Record<Surface, ReadonlyArray<keyof DiffClasses>> = {
	code: ["code"],
	prose: ["markdown"],
	plan: ["markdown"],
	workflows: ["workflows"],
};

/** Every markdown file gets these, under either markdown surface. */
const MARKDOWN_SCAN = "markdown link + leak scan";
/** `plan` runs this **on top of** {@link MARKDOWN_SCAN}; it is a specialization, not a substitute. */
const PLAN_GRAMMAR = "## Dependencies grammar";

/**
 * The changed files this surface's validators do not read — what a green must disclose.
 *
 * A superset of the `unvalidatable` bucket, and the extra members are the whole point: `--surface
 * code` ran typecheck and `lint:worktree` over a `["a.ts", "README.md"]` diff, neither of which reads
 * markdown (`lint:worktree` filters `.md` out by extension), and greened with an empty disclosure —
 * which affirmatively reads as "nothing uncovered". `--surface plan` did the same to code files.
 * Reporting coverage per surface answers both with one rule instead of two (#5288).
 *
 * Disclosing is deliberately not validating: running the markdown validators under `--surface code`
 * would make the surface guess at file classes, which the anchor exists to refuse.
 */
export const notCoveredBy = (
	surface: Surface,
	files: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const classes = classifyDiff(files);
	const covered = new Set(COVERS[surface].flatMap((bucket) => classes[bucket]));
	return files.filter((file) => !covered.has(file));
};

/**
 * Why no surface can validate this diff at all, or `null`.
 *
 * Checked **before** {@link surfaceMismatch}, so a wholly-unvalidatable diff refuses with the honest
 * reason under every surface — including `code`, whose old "the diff changes no code file" was a true
 * sentence pointing at the wrong remedy (it invites `--surface prose`, the branch that greened).
 */
export const unvalidatableDiff = (files: ReadonlyArray<string>): string | null => {
	const {code, markdown, workflows, unvalidatable} = classifyDiff(files);
	if (code.length > 0 || markdown.length > 0 || workflows.length > 0) return null;
	const shown = unvalidatable.slice(0, 5).join(", ");
	const rest = unvalidatable.length > 5 ? `, +${unvalidatable.length - 5} more` : "";
	return `no surface validates any of the ${unvalidatable.length} changed file(s) (${shown}${rest})`;
};

/**
 * Why `--surface` provably contradicts the diff, or `null`.
 *
 * One rule for every surface, read straight off {@link COVERS}: a surface is refused when the
 * diff holds **none** of the file classes its validators open. `prose` used to refuse on the
 * *presence* of a code file instead, and that asymmetry left the repo's most common diff shape — one
 * `.ts` plus one `.md` — with no invocation that opened the markdown at all: `code` never reads it,
 * `plan` runs the wrong validator, and `prose` refused on `10`. The leak scan and the link resolver
 * simply did not run (#5301). The presence of another class is not a contradiction; it is what
 * `unvalidated` discloses.
 */
export const surfaceMismatch = (surface: Surface, files: ReadonlyArray<string>): string | null => {
	const classes = classifyDiff(files);
	const covered = COVERS[surface].flatMap((bucket) => classes[bucket]);
	if (covered.length > 0) return null;
	return `--surface ${surface}, but the diff changes no ${COVERS[surface].join("/")} file`;
};

/**
 * The machine-local paths a committed prose file carries, as defect lines.
 *
 * The scanner is {@link docLeaks}, the committed-file one — not `report/leaks.ts`'s body scanner,
 * which this verb used to call. That scanner guards runtime issue bodies, an ungated surface, and
 * it is deliberately stricter than the repo's committed-file gate on three axes; asking it about a
 * file in a diff made this predictor red on bytes CI passes clean, and the red was unclearable in
 * the lane that inherited it (#5687). See `doc-leaks.ts` for the three divergences.
 */
const leakDefects = (
	file: string,
	text: string,
	exempt: ReadonlyArray<string>,
): ReadonlyArray<string> =>
	docLeaks(file, text, exempt).map(
		(leak) => `${file}:${leak.line} carries a machine-local path (${leak.reason}): ${leak.matched}`,
	);

/** Fold `.` and `..` out of an absolute path, so a link's target is compared in one spelling. */
export const normalizePath = (path: string): string => {
	const out: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") out.pop();
		else out.push(segment);
	}
	return `/${out.join("/")}`;
};

/** Every byte replaced by a space, newlines kept, so masking moves no offset and no line number. */
const blank = (text: string): string => text.replace(/[^\n]/g, " ");

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Blank out every code span in a fence-free region. A run of n backticks opens a span the next run
 * of exactly n backticks closes; a run with no partner is literal text and masks nothing.
 */
const maskSpans = (text: string): string => {
	let out = "";
	let i = 0;
	while (i < text.length) {
		if (text[i] !== "`") {
			out += text[i];
			i += 1;
			continue;
		}
		let open = i;
		while (text[open] === "`") open += 1;
		const run = open - i;
		const closer = new RegExp(`(?<!\`)\`{${run}}(?!\`)`, "g");
		closer.lastIndex = open;
		const close = closer.exec(text);
		if (close === null) {
			out += text.slice(i, open);
			i = open;
			continue;
		}
		const end = close.index + run;
		out += blank(text.slice(i, end));
		i = end;
	}
	return out;
};

/**
 * Blank out fenced blocks and code spans, so a markdown link written as an *illustration* is not
 * extracted as a live one (#5639). The docs that state this repo's link convention are precisely
 * the docs that spell a link out as an example, and they were the ones this predictor red.
 *
 * Masked bytes become spaces rather than being dropped: the link pattern cannot cross whitespace,
 * so a masked example can never fuse with live text on either side of it.
 */
const maskCode = (text: string): string => {
	const out: string[] = [];
	let prose: string[] = [];
	let fence: string | null = null;
	const flush = () => {
		if (prose.length > 0) out.push(maskSpans(prose.join("\n")));
		prose = [];
	};
	for (const line of text.split("\n")) {
		const marker = FENCE_RE.exec(line)?.[1];
		if (fence !== null) {
			out.push(blank(line));
			if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
				fence = null;
			}
			continue;
		}
		if (marker !== undefined) {
			flush();
			out.push(blank(line));
			fence = marker;
			continue;
		}
		prose.push(line);
	}
	flush();
	return out.join("\n");
};

/**
 * Every in-repo link target a markdown file names, ignoring the ones written as examples.
 *
 * Absolute URLs and bare fragments are skipped: a link with a scheme is not this tree's to resolve,
 * and a fragment resolves within the page. A fabrika doc cited by a relative path is covered by the
 * same rule, so there is no second reference check to drift from this one.
 *
 * The extractor stays a regex over masked text rather than moving to a markdown parser: fabrika is
 * installed into repos it does not control (ADR 0273) on four runtime dependencies, and code-span
 * plus fenced-block masking is the one property #2308 bought by retiring the CI gate's in-house
 * extractor. Reference-style and HTML links stay out of scope here, as they always were.
 */
export const linkTargets = (text: string): ReadonlyArray<string> => {
	const targets: string[] = [];
	for (const match of maskCode(text).matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
		const target = (match[1] ?? "").split("#")[0]?.trim() ?? "";
		if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
		targets.push(target);
	}
	return targets;
};

const planDefects = (file: string, text: string): ReadonlyArray<string> => {
	const topology = readTopology(text);
	if (topology._tag === "Absent") return [];
	if (topology._tag === "Unparseable") {
		return [
			`${file}:${topology.line} does not parse under the "## Dependencies" grammar: "${topology.text}"`,
		];
	}
	const defects: string[] = [];
	const declared = topology.edges.flatMap((edge) =>
		edge._tag === "Phase" ? edge.members : [edge.subject, ...edge.needs],
	);
	for (const edge of topology.edges) {
		if (edge._tag !== "Requires") continue;
		if (edge.needs.some((need) => sameRef(need, edge.subject))) {
			defects.push(`${file}: ${renderRef(edge.subject)} requires itself`);
		}
	}
	for (const ref of declared) {
		if (ref._tag !== "Local") continue;
		const named = topology.edges.some(
			(edge) => edge._tag === "Phase" && edge.members.some((member) => sameRef(member, ref)),
		);
		if (!named) defects.push(`${file}: ${renderRef(ref)} is not named by any phase line`);
	}
	for (const ref of declared) {
		if (ref._tag !== "Issue") continue;
		const cycle = predecessorsOf(topology.edges, ref).some(({ref: predecessor}) =>
			sameRef(predecessor, ref),
		);
		if (cycle) defects.push(`${file}: #${ref.number} is its own predecessor`);
	}
	return defects;
};

/** A changed markdown file resolves three ways, and only the middle one is safe to skip. */
type MarkdownRead =
	| {readonly _tag: "Read"; readonly text: string}
	| {readonly _tag: "Absent"}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/**
 * Read a changed markdown file, keeping "it is gone" apart from "I could not open it".
 *
 * Absence is the one fault a green may absorb: a file the diff lists and the tree no longer holds
 * was deleted, and there is nothing left to validate. Every other fault is a read that did not
 * execute, so it proves nothing and must refuse — the same 404-vs-5xx split `codes.ts` states for
 * {@link ZERO_SCOPE} against {@link PRECONDITION_UNKNOWN}. One `catchTag("PlatformError")` fused
 * them and skipped both, so a permission or IO fault dropped a file out of validation while
 * `unvalidated` stayed empty (#5304).
 *
 * `reason._tag === "NotFound"` is the proof, not a guess: `@effect/platform-node-shared`'s
 * `handleErrnoException` maps `ENOENT` to `NotFound` and `EACCES` to `PermissionDenied`, and
 * effect's own `FileSystem.exists` narrows on this exact field.
 */
const readMarkdown = (
	fs: FileSystem.FileSystem,
	path: string,
): Effect.Effect<MarkdownRead, never> =>
	fs.readFileString(path).pipe(
		Effect.map((text): MarkdownRead => ({_tag: "Read", text})),
		Effect.catchTag("PlatformError", (error) =>
			Effect.succeed<MarkdownRead>(
				error.reason._tag === "NotFound"
					? {_tag: "Absent"}
					: {_tag: "Unreadable", reason: error.reason._tag},
			),
		),
	);

/** The declared exemptions, or why there are none — `Unreadable` is the one answer a green may not absorb. */
type ExemptScope =
	| {readonly _tag: "Scope"; readonly paths: ReadonlyArray<string>; readonly note: string}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/**
 * Read the repo's declared leak-scan exemptions off `.fabrika.jsonc`.
 *
 * An absent file is a repo that declared none, which is the fail-closed answer — nothing is exempt,
 * the scanner stays strictest. Any other read fault proves nothing, so it refuses like
 * {@link readMarkdown}'s does.
 */
const readExemptScope = (
	fs: FileSystem.FileSystem,
	root: string,
): Effect.Effect<ExemptScope, never> =>
	fs.readFileString(`${root}/${CONFIG_PATH}`).pipe(
		Effect.map((text): ExemptScope => {
			const read = readDocLeakExempt(text);
			return read._tag === "Paths"
				? {
						_tag: "Scope",
						paths: read.paths,
						note: `${VERB}: ${read.paths.length} leak-scan exemption(s) declared in ${CONFIG_PATH}.`,
					}
				: {
						_tag: "Scope",
						paths: [],
						note: `${VERB}: nothing is leak-scan exempt — ${read.reason}.`,
					};
		}),
		Effect.catchTag("PlatformError", (error) =>
			Effect.succeed<ExemptScope>(
				error.reason._tag === "NotFound"
					? {
							_tag: "Scope",
							paths: [],
							note: `${VERB}: nothing is leak-scan exempt — this repo has no ${CONFIG_PATH}.`,
						}
					: {_tag: "Unreadable", reason: error.reason._tag},
			),
		),
	);

/**
 * A failed validator's captured output as refusal lines, bounded so one runaway linter cannot bury
 * the verdict it belongs to. The truncation says so rather than trailing off silently.
 */
const DIAGNOSTIC_LINES = 40;

const diagnostics = (output: string): ReadonlyArray<string> => {
	const lines = output.split("\n").filter((line) => line.trim() !== "");
	return lines.length <= DIAGNOSTIC_LINES
		? lines
		: [
				...lines.slice(0, DIAGNOSTIC_LINES),
				`… ${lines.length - DIAGNOSTIC_LINES} more line(s); re-run the command itself for the rest.`,
			];
};

/** The declared workflow validators, or why there are none — `Unreadable` is the one UNKNOWN answer. */
type ValidatorScope =
	| {readonly _tag: "Scope"; readonly commands: ReadonlyArray<Argv>; readonly note: string}
	| {readonly _tag: "Unreadable"; readonly reason: string};

const readValidatorScope = (
	fs: FileSystem.FileSystem,
	root: string,
): Effect.Effect<ValidatorScope, never> =>
	fs.readFileString(`${root}/${CONFIG_PATH}`).pipe(
		Effect.map((text): ValidatorScope => {
			const read = readWorkflowValidators(text);
			return read._tag === "Validators"
				? {
						_tag: "Scope",
						commands: read.commands,
						note: `${VERB}: ${read.commands.length} workflow validator(s) declared in ${CONFIG_PATH}.`,
					}
				: {
						_tag: "Scope",
						commands: [],
						note: `${VERB}: no repo workflow validator is declared — ${read.reason}.`,
					};
		}),
		Effect.catchTag("PlatformError", (error) =>
			Effect.succeed<ValidatorScope>(
				error.reason._tag === "NotFound"
					? {
							_tag: "Scope",
							commands: [],
							note: `${VERB}: no repo workflow validator is declared — this repo has no ${CONFIG_PATH}.`,
						}
					: {_tag: "Unreadable", reason: error.reason._tag},
			),
		),
	);

/**
 * The `workflows` surface: `actionlint` over the changed workflow files, plus the repo's own
 * declared workflow commands. A green requires that at least one of them actually ran.
 *
 * `actionlint` is not a repo dependency anywhere — in phoenix CI installs a pinned tarball at job
 * time — so a tree that lacks it is the ordinary case, not a broken one. It is therefore run when
 * present and **disclosed** when absent, which is the "degrade, stated" answer `SKILL.md`'s
 * missing-surface table gives for an absent superseding authority: `ci.yml`'s `actionlint` job still
 * decides. A declared validator is the other row of that table — it ships with the repo, so one that
 * cannot be spawned is fail-loud, UNKNOWN, never green.
 *
 * What holds both readings honest is the last check: when *nothing* ran, the verb has opened no
 * workflow file, and a green there would be exactly the unread-tree green the third file class was
 * introduced to make refusable (#5229).
 */
const runWorkflowSurface = (
	fs: FileSystem.FileSystem,
	root: string,
	workflows: ReadonlyArray<string>,
	unvalidated: ReadonlyArray<string>,
	noted: ReadonlyArray<string>,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const declared = yield* readValidatorScope(fs, root);
		if (declared._tag === "Unreadable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${CONFIG_PATH} (${declared.reason}) — which commands validate this repo's workflows is UNKNOWN, never green.`,
				noted,
			);
		}
		const scoped = [...noted, declared.note];
		const ran: string[] = [];
		const lint = yield* execStatus(ACTIONLINT, workflows);
		const notInstalled = lint._tag === "Unstartable" ? lint.reason : null;
		if (lint._tag === "Ran") {
			if (!lint.ok) {
				return refuse(VALIDATION_RED, `${VERB}: red — ${ACTIONLINT} failed; diagnostics above.`, [
					...scoped,
					...diagnostics(lint.output),
				]);
			}
			ran.push(ACTIONLINT);
		}
		for (const argv of declared.commands) {
			const label = argv.join(" ");
			const result = yield* execStatus(argv[0], argv.slice(1));
			if (result._tag === "Unstartable") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: ${label} could not be executed: ${result.reason} — the verdict is UNKNOWN, never green.`,
					scoped,
				);
			}
			if (!result.ok) {
				return refuse(VALIDATION_RED, `${VERB}: red — ${label} failed; diagnostics above.`, [
					...scoped,
					...diagnostics(result.output),
				]);
			}
			ran.push(label);
		}
		if (ran.length === 0) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: no workflow validator could be executed — ${ACTIONLINT} is not installed here (${notInstalled}) and this repo declares none — so no file was opened and the verdict is UNKNOWN, never green.`,
				scoped,
			);
		}
		const disclosed =
			notInstalled === null
				? scoped
				: [
						...scoped,
						`${VERB}: ${ACTIONLINT} did NOT run (${notInstalled}) — ci.yml's actionlint job supersedes this verdict on workflow syntax.`,
					];
		return answer(
			JSON.stringify({verdict: "green", surface: "workflows", tree: root, ran, unvalidated}),
			disclosed,
		);
	});

export const runCheck = (
	options: CheckOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const surface = options.surface.trim().toLowerCase();
		if (!(SURFACES as ReadonlyArray<string>).includes(surface)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --surface "${options.surface}" is off the closed vocabulary (${SURFACES.join(" | ")}).`,
			);
		}
		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		const lane = yield* requireLane(VERB, resolved.repo, session.id, null);
		if (lane._tag === "Refused") return lane.outcome;

		const branch = yield* defaultBranch(resolved.repo);
		if (branch._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${resolved.repo}'s default branch: ${branch.reason} — the diff base is UNKNOWN, never green.`,
				lane.notes,
			);
		}
		const base = `origin/${branch.value}`;
		const merged = yield* mergeBase(base);
		if (merged._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve the merge base with ${base}: ${merged.reason} — the verdict is UNKNOWN, never green.`,
				lane.notes,
			);
		}
		const listed = yield* changedFiles(merged.value);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot enumerate the files changed against ${base}: ${listed.reason} — the verdict is UNKNOWN, never green.`,
				lane.notes,
			);
		}
		const files = listed.value;
		const scope = [...lane.notes, `${VERB}: ${files.length} changed file(s) against ${base}.`];
		if (files.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: this tree changes nothing against ${base}, tracked or untracked — nothing to validate (ADR 0092).`,
				scope,
			);
		}
		const unvalidatable = unvalidatableDiff(files);
		if (unvalidatable !== null) {
			return refuse(
				UNCLASSIFIED_DIFF,
				`${VERB}: ${unvalidatable} — there is nothing here to run, so the verdict is a refusal, never green.`,
				scope,
			);
		}
		const mismatch = surfaceMismatch(surface as Surface, files);
		if (mismatch !== null) {
			return refuse(OFF_VOCABULARY, `${VERB}: ${mismatch} — the surface is provably wrong.`, scope);
		}
		const {markdown} = classifyDiff(files);
		// A partial green has to carry what it skipped, on both channels: #5187 greened over 25 workflow
		// files whose `ran` line was true and misleading at once (#5229), and a `--surface code` green
		// then did the same to markdown while reporting an empty list (#5288).
		const unvalidated = notCoveredBy(surface as Surface, files);
		const noted =
			unvalidated.length === 0
				? scope
				: [
						...scope,
						`${VERB}: ${unvalidated.length} changed file(s) --surface ${surface} does not validate — NOT covered by this verdict: ${unvalidated.join(", ")}.`,
					];

		if (surface === "code") {
			const ran: string[] = [];
			for (const runner of CODE_RUNNERS) {
				const result = yield* execCapture("pnpm", runner.argv);
				ran.push(runner.label);
				if (!result.ok) {
					return refuse(
						VALIDATION_RED,
						`${VERB}: red — ${runner.label} failed; diagnostics above.`,
						[...noted, result.reason],
					);
				}
			}
			return answer(
				JSON.stringify({verdict: "green", surface, tree: lane.root, ran, unvalidated}),
				noted,
			);
		}

		const fs = yield* FileSystem.FileSystem;
		if (surface === "workflows") {
			return yield* runWorkflowSurface(
				fs,
				lane.root,
				classifyDiff(files).workflows,
				unvalidated,
				noted,
			);
		}

		const exempt = yield* readExemptScope(fs, lane.root);
		if (exempt._tag === "Unreadable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${CONFIG_PATH} (${exempt.reason}) — which docs are leak-scan exempt is UNKNOWN, never green.`,
				noted,
			);
		}
		const scoped = [...noted, exempt.note];
		const defects: string[] = [];
		for (const file of markdown) {
			const path = `${lane.root}/${file}`;
			const read = yield* readMarkdown(fs, path);
			if (read._tag === "Absent") continue;
			if (read._tag === "Unreadable") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${file} (${read.reason}) — it is in the diff and is not absent, so the verdict is UNKNOWN, never green.`,
					scoped,
				);
			}
			defects.push(...leakDefects(file, read.text, exempt.paths));
			const dir = path.slice(0, path.lastIndexOf("/"));
			for (const target of linkTargets(read.text)) {
				const absolute = normalizePath(
					target.startsWith("/") ? `${lane.root}${target}` : `${dir}/${target}`,
				);
				const there = yield* fs
					.exists(absolute)
					.pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)));
				if (!there) defects.push(`${file} links to "${target}", which does not resolve`);
			}
			if (surface === "plan") defects.push(...planDefects(file, read.text));
		}
		if (defects.length > 0) {
			return refuse(
				VALIDATION_RED,
				`${VERB}: red — the ${surface} validators failed; diagnostics above.`,
				[...scoped, ...defects],
			);
		}
		return answer(
			JSON.stringify({
				verdict: "green",
				surface,
				tree: lane.root,
				ran: surface === "plan" ? [MARKDOWN_SCAN, PLAN_GRAMMAR] : [MARKDOWN_SCAN],
				unvalidated,
			}),
			scoped,
		);
	});
