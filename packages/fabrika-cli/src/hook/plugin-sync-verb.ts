/**
 * `hook plugin-sync` — advance the checkout a directory-source marketplace is served from, so the
 * next spawned shell's preloaded skill text is the text that landed.
 *
 * A `skills:` preload is rendered from the harness's **copy** of the plugin tree, and that copy is
 * taken from the marketplace's source directory at whatever commit that directory's primary worktree
 * sat at. So a skill-class merge binds a shell only after the source directory has advanced to it.
 * Nothing in the harness advances it — it is an ordinary git checkout — and for as long as that step
 * was a driver's to remember, a landed correction to a skill went on being invisible to every shell
 * spawned afterwards, silently: preloaded text names no version, so a shell cannot tell it is running
 * retired guidance. That window is what this verb closes, and it closes it by being a hook rather
 * than a step: the harness fires it, so there is nothing to forget.
 *
 * **It runs in the source directory's primary worktree, never in the session's own.** A linked
 * worktree is not what the harness copies, and moving the session's tree would be a mutation nobody
 * asked for. The primary worktree is read off `git rev-parse --path-format=absolute
 * --git-common-dir`, which every linked worktree of a clone answers with the one shared directory.
 *
 * **It takes fast-forwards and nothing else.** Every other state — a parked branch, a detached HEAD,
 * uncommitted work, a diverged branch — is refused with its reason on stderr, because where a
 * human's checkout sits is a human's call. The refusal is the loud half of the guarantee: a plugin
 * source that has stopped advancing is precisely the state that used to pass unnoticed.
 *
 * **The second link is reported, never driven.** Re-copying the advanced directory into the plugin
 * cache is the harness's own `autoUpdate` pass. This verb reads the harness's install records and
 * says which installs are still bound to an earlier commit, so a session is told in its own
 * transcript when the text it is about to load is not the text on the branch.
 *
 * Nothing here names a repository, a marketplace or a plugin. The marketplace is selected by the
 * directory it declares, so an adopting repo needs only to declare the hook.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9031#issuecomment-5625309469
 */
import {Effect, FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type ChildOutcome, execRecord} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	EMPTY_STDIN,
	ENVELOPE_UNKNOWN,
	FAST_FORWARD_FAILED,
	GROUND_UNKNOWN,
	MALFORMED_ENVELOPE,
	REMOTE_UNREADABLE,
	SYNC_REFUSED,
	WRONG_EVENT,
} from "./codes.ts";
import {classifyEnvelope, type EnvelopeRead} from "./envelope.ts";
import {
	directoryMarketplacesAt,
	type InstallReport,
	installsFrom,
	plan,
	reportInstalls,
	type SyncPlan,
	short,
	type WorktreeFacts,
} from "./plugin-sync.ts";
import {childEnv} from "./worktree-create.ts";

const VERB = "fabrika hook plugin-sync";
const EVENT = "SessionStart";

/** Generous enough for a fetch on a slow link, and well inside the budget the declaration gives. */
const GIT_TIMEOUT_SECONDS = 100;
const CAPTURE_BYTES = 32 * 1024;

export interface PluginSyncOptions {
	readonly stdin: Effect.Effect<StdinRead>;
	/** Read and report, move nothing. The declared hook can never pass it — rule 5 forbids flags. */
	readonly dryRun: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

type Requirements = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem;

const readEnvelope = (piped: StdinRead): EnvelopeRead =>
	piped._tag === "Text" ? classifyEnvelope(piped.text) : {_tag: "Unknown", reason: piped.reason};

/**
 * One git read or move, in a named directory, under the hook-safe child environment.
 *
 * The environment is `childEnv`'s rather than this process's: a hook is exec'd with a stripped
 * `PATH`, and an interactive credential prompt inside a session-start hook would hang the session
 * instead of failing it. Both are already answered beside the worktree provider, so this reuses that
 * answer rather than restating half of it.
 */
const git = (
	args: ReadonlyArray<string>,
	cwd: string,
	env: Readonly<Record<string, string>>,
): Effect.Effect<ChildOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	execRecord({
		file: "git",
		args,
		cwd,
		env,
		timeoutSeconds: GIT_TIMEOUT_SECONDS,
		captureBytes: CAPTURE_BYTES,
	});

const ran = (outcome: ChildOutcome): boolean =>
	outcome._tag === "Ran" && !outcome.timedOut && outcome.exitCode === 0;

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).trim();

const stdoutOf = (outcome: ChildOutcome): string =>
	outcome._tag === "Ran" ? text(outcome.stdout) : "";

const why = (outcome: ChildOutcome): string => {
	if (outcome._tag === "Unstartable") return `could not run git — ${outcome.reason}`;
	if (outcome.timedOut) return `git did not finish within ${GIT_TIMEOUT_SECONDS}s`;
	const first = text(outcome.stderr).split("\n")[0] ?? "";
	return first === "" ? `git exited ${outcome.exitCode}` : first;
};

/**
 * The primary worktree of the clone the session's `cwd` belongs to.
 *
 * Derived from the **common** git dir rather than from `--show-toplevel`, which answers the session's
 * own tree: in a linked worktree those are different directories, and only the common one leads back
 * to the checkout a directory marketplace is registered against. A common dir that does not end in
 * `/.git` is a bare clone or a layout this verb cannot reason about, so it yields nothing rather
 * than a directory it guessed at.
 */
const primaryWorktree = (
	cwd: string,
	env: Readonly<Record<string, string>>,
): Effect.Effect<string | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
	git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, env).pipe(
		Effect.map((outcome) => {
			if (!ran(outcome)) return null;
			const common = stdoutOf(outcome);
			return common.endsWith("/.git") ? common.slice(0, -"/.git".length) : null;
		}),
	);

/** The branch `origin/HEAD` names, or `main` when the clone has never recorded one. */
const defaultBranchOf = (
	root: string,
	env: Readonly<Record<string, string>>,
): Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner> =>
	git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root, env).pipe(
		Effect.map((outcome) => {
			if (!ran(outcome)) return "main";
			const ref = stdoutOf(outcome);
			const slash = ref.indexOf("/");
			return slash > 0 ? ref.slice(slash + 1) : "main";
		}),
	);

/** Read every fact the plan needs, after the fetch that makes the remote half current. */
const readFacts = (
	root: string,
	defaultBranch: string,
	env: Readonly<Record<string, string>>,
): Effect.Effect<WorktreeFacts | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const onBranch = yield* git(["symbolic-ref", "--quiet", "--short", "HEAD"], root, env);
		const head = yield* git(["rev-parse", "HEAD"], root, env);
		const remote = yield* git(["rev-parse", `refs/remotes/origin/${defaultBranch}`], root, env);
		if (!ran(head) || !ran(remote)) return null;
		const status = yield* git(["status", "--porcelain"], root, env);
		if (!ran(status)) return null;
		const headCommit = stdoutOf(head);
		const remoteCommit = stdoutOf(remote);
		const ancestor = yield* git(
			["merge-base", "--is-ancestor", headCommit, remoteCommit],
			root,
			env,
		);
		return {
			branch: ran(onBranch) ? stdoutOf(onBranch) : null,
			defaultBranch,
			dirty: stdoutOf(status) !== "",
			head: headCommit,
			remoteHead: remoteCommit,
			fastForwardable: ran(ancestor),
		};
	});

/** Where the harness keeps its plugin records. `CLAUDE_CONFIG_DIR` wins where the operator set it. */
const configDir = (env: Readonly<Record<string, string | undefined>>): string | null => {
	const explicit = env.CLAUDE_CONFIG_DIR?.trim();
	if (explicit !== undefined && explicit !== "") return explicit;
	const home = env.HOME?.trim();
	return home === undefined || home === "" ? null : `${home}/.claude`;
};

const readJson = (path: string): Effect.Effect<unknown, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const raw = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
		if (raw.trim() === "") return null;
		return yield* Effect.try({
			try: () => JSON.parse(raw) as unknown,
			catch: (cause): string => (cause instanceof Error ? cause.message : String(cause)),
		}).pipe(Effect.orElseSucceed(() => null));
	});

/**
 * What the harness's own records say about the copies taken from this directory.
 *
 * Every unreadable step folds to `Unknown` with the reason, never to `Bound`: this half of the
 * report exists to say when a landed change has *not* reached the cache, so an unread record must
 * never read as one that reached it.
 */
const installReport = (
	env: Readonly<Record<string, string | undefined>>,
	directory: string,
	sourceCommit: string,
): Effect.Effect<InstallReport, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const config = configDir(env);
		if (config === null) {
			return {
				_tag: "Unknown",
				reason: "neither CLAUDE_CONFIG_DIR nor HOME names a config directory",
			};
		}
		const marketplaces = directoryMarketplacesAt(
			yield* readJson(`${config}/plugins/known_marketplaces.json`),
			directory,
		);
		if (marketplaces.length === 0) {
			return {
				_tag: "Unknown",
				reason: `no registered marketplace names ${directory} as its source`,
			};
		}
		const rows = installsFrom(
			yield* readJson(`${config}/plugins/installed_plugins.json`),
			marketplaces,
		);
		return reportInstalls(rows, sourceCommit);
	});

/** The install half as stderr lines — one verdict line, then one line per lagging install. */
const installLines = (report: InstallReport, sourceCommit: string): ReadonlyArray<string> => {
	if (report._tag === "Unknown") {
		return [`${VERB}: install binding UNKNOWN — ${report.reason}`];
	}
	if (report._tag === "Bound") {
		return [
			`${VERB}: every install taken from this directory is bound at ${short(sourceCommit)} — the next spawned shell preloads this commit's text.`,
		];
	}
	return [
		`${VERB}: ${report.rows.length} install binding(s) are still copied from an earlier commit than ${short(sourceCommit)}. The harness re-copies on its own autoUpdate pass; until it does, a shell spawned against one of them preloads the older text.`,
		...report.rows.map(
			(row) =>
				`${VERB}:   ${row.pluginId} bound at ${short(row.commit)} by ${row.records} scope record(s)`,
		),
	];
};

const planLine = (outcome: SyncPlan, dryRun: boolean): string => {
	if (outcome._tag === "Current") {
		return `${VERB}: ${outcome.branch} is already at ${short(outcome.commit)}.`;
	}
	if (outcome._tag === "Refused") return `${VERB}: ${outcome.reason}`;
	const verb = dryRun ? "would fast-forward" : "fast-forwarded";
	return `${VERB}: ${verb} ${outcome.branch} ${short(outcome.from)}..${short(outcome.to)}.`;
};

/**
 * The answer line, over the two plans that produce one.
 *
 * `Refused` is excluded in the type rather than handled and never reached: a refusal's answer channel
 * is empty by the interface convention, so a token for one is a value this verb may never construct.
 */
const token = (outcome: Exclude<SyncPlan, {_tag: "Refused"}>, dryRun: boolean): string => {
	if (outcome._tag === "Current") return `current\t${outcome.branch}\t${short(outcome.commit)}`;
	return `${dryRun ? "would-advance" : "advanced"}\t${outcome.branch}\t${short(outcome.to)}`;
};

/**
 * A refusal whose **reason is stderr's first line**, with its context after — this verb's order, not
 * the CLI's.
 *
 * A failed `SessionStart` hook surfaces one line in the session, and `refuse` writes its `extra`
 * lines ahead of the reason, so every refusal here read as `judging the plugin source at <root>` and
 * named no cause. The reason for the refusal that cost a replay to recover sat eighth, behind the
 * scope line and six install-binding lines.
 *
 * `refuse` still constructs the outcome, so the code and the empty stdout stay its invariants and
 * the CLI-wide extras-before-reason order is untouched everywhere else. Only the context this verb
 * adds moves, and it moves to the back.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9460
 */
const refuseLeadingWithReason = (
	code: number,
	reason: string,
	context: ReadonlyArray<string> = [],
): VerbOutcome => {
	const outcome = refuse(code, reason);
	return {...outcome, stderr: [...outcome.stderr, ...context]};
};

export const runPluginSync = ({
	stdin,
	dryRun,
	env,
}: PluginSyncOptions): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const read = readEnvelope(yield* stdin);
		if (read._tag === "Empty") {
			return refuseLeadingWithReason(
				EMPTY_STDIN,
				`${VERB}: stdin was read and held no ${EVENT} envelope`,
			);
		}
		if (read._tag === "Unknown") {
			return refuseLeadingWithReason(
				ENVELOPE_UNKNOWN,
				`${VERB}: envelope UNKNOWN — ${read.reason}`,
			);
		}
		if (read._tag === "Malformed") {
			return refuseLeadingWithReason(
				MALFORMED_ENVELOPE,
				`${VERB}: not a hook envelope — ${read.reason}`,
				[`${VERB}: ${read.evidence}`],
			);
		}
		if (read.envelope.event !== EVENT) {
			return refuseLeadingWithReason(
				WRONG_EVENT,
				`${VERB}: judges ${EVENT} and the envelope is ${read.envelope.event} — the declaration is wired to the wrong event`,
			);
		}

		const child = childEnv(env);
		const root = yield* primaryWorktree(read.envelope.cwd, child);
		if (root === null) {
			return refuseLeadingWithReason(
				GROUND_UNKNOWN,
				`${VERB}: the envelope's cwd (${read.envelope.cwd}) names no clone whose primary worktree this verb can read`,
			);
		}
		const scope = `${VERB}: judging the plugin source at ${root}`;

		const defaultBranch = yield* defaultBranchOf(root, child);
		const fetched = yield* git(["fetch", "--quiet", "origin", defaultBranch], root, child);
		if (!ran(fetched)) {
			return refuseLeadingWithReason(
				REMOTE_UNREADABLE,
				`${VERB}: could not fetch origin/${defaultBranch} — whether this checkout is current is UNKNOWN: ${why(fetched)}`,
				[scope],
			);
		}

		const facts = yield* readFacts(root, defaultBranch, child);
		if (facts === null) {
			return refuseLeadingWithReason(
				GROUND_UNKNOWN,
				`${VERB}: fetched origin/${defaultBranch} and could not read this checkout's own state`,
				[scope],
			);
		}

		const decided = plan(facts);
		if (decided._tag === "Refused") {
			return refuseLeadingWithReason(SYNC_REFUSED, planLine(decided, dryRun), [
				scope,
				...installLines(yield* installReport(env, root, facts.head), facts.head),
			]);
		}

		if (decided._tag === "FastForward" && !dryRun) {
			const merged = yield* git(
				["merge", "--ff-only", `refs/remotes/origin/${defaultBranch}`],
				root,
				child,
			);
			if (!ran(merged)) {
				return refuseLeadingWithReason(
					FAST_FORWARD_FAILED,
					`${VERB}: ${decided.branch} passed every precondition and the fast-forward failed — the checkout changed under the read: ${why(merged)}`,
					[scope],
				);
			}
		}

		// What the source directory sits at once this verb is done with it — the commit the install
		// report is measured against. A dry run moved nothing, so it is still the head that was read.
		const landed = dryRun ? facts.head : facts.remoteHead;
		return answer(`${token(decided, dryRun)}\n`, [
			scope,
			planLine(decided, dryRun),
			...installLines(yield* installReport(env, root, landed), landed),
		]);
	});
