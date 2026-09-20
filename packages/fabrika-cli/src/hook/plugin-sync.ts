/**
 * The decision core behind `hook plugin-sync` — everything it decides, with no process and no disk.
 *
 * The distribution fact this exists for: a marketplace whose `source.source` is `directory` is not
 * bound to that directory live. The harness **copies** the tree into its own plugin cache under a
 * name keyed by the commit the directory sat at, records that commit as the install's
 * `gitCommitSha`, and a spawned shell's `skills:` preload is rendered out of that copy. So the text
 * an agent runs is only ever as current as the commit the source directory's **primary worktree**
 * was checked out at when the harness last copied it.
 *
 * That leaves exactly two links between a landed skill change and the shell that runs it, and only
 * one of them is ownable from a repository:
 *
 * 1. the source directory's primary worktree advancing to the landed commit — **this verb's**, and
 *    the one a human used to have to remember;
 * 2. the harness re-copying that directory — the harness's own `autoUpdate` pass, which no verb
 *    here drives and none pretends to.
 *
 * So the plan below moves link 1 and *reports* link 2. Reporting it is not a consolation prize: an
 * install still bound to an ancestor commit is the state where a green merge does not reach the next
 * shell, and a pipeline that cannot say that out loud is the pipeline this verb was filed against.
 *
 * Nothing here is repository-specific. The marketplace is selected by the directory it names, not by
 * a name this file knows, so an adopting repo needs no entry anywhere.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9031#issuecomment-5625309469
 */

/** Fields the plan reads off the source directory's primary worktree. Every one is a git read. */
export interface WorktreeFacts {
	/** The branch checked out in the primary worktree, or `null` on a detached HEAD. */
	readonly branch: string | null;
	/** The branch `origin/HEAD` points at — what "current" is measured against. */
	readonly defaultBranch: string;
	/**
	 * Every path the primary worktree carries uncommitted, tracked or not, one entry per file.
	 *
	 * There is no separate yes/no dirtiness fact: two facts about one tree can disagree, and the arm
	 * that reads them only ever wanted the paths.
	 */
	readonly dirtyPaths: ReadonlyArray<string>;
	/** The commit the primary worktree is at. */
	readonly head: string;
	/** The commit `origin/<defaultBranch>` is at, as of the fetch this plan is read after. */
	readonly remoteHead: string;
	/** Every path the commits between {@link head} and {@link remoteHead} change. */
	readonly incomingPaths: ReadonlyArray<string>;
	/** Whether {@link head} is an ancestor of {@link remoteHead} — the fast-forward test itself. */
	readonly fastForwardable: boolean;
}

/**
 * What to do with the source directory's primary worktree.
 *
 * `Refused` is a first-class outcome rather than an error: a primary worktree parked on a branch, or
 * carrying a human's uncommitted work, is an ordinary state this verb must leave exactly as it found
 * it. What it may never do is leave it *silently* — the refusal carries the reason so the session
 * that fired the hook is told why its plugin source is not advancing.
 */
export type SyncPlan =
	| {
			readonly _tag: "FastForward";
			readonly branch: string;
			readonly from: string;
			readonly to: string;
	  }
	| {readonly _tag: "Current"; readonly branch: string; readonly commit: string}
	| {readonly _tag: "Refused"; readonly reason: string};

/**
 * Decide from the facts, in the one order that never proposes a move it cannot prove is safe.
 *
 * The detached and off-default arms come first because on either of them the remaining facts answer
 * a question nobody asked — `fastForwardable` against `origin/HEAD` says nothing about a worktree
 * deliberately parked on a lane branch. The clobber arm comes before the ancestry arm because the
 * move it guards is the one the ancestry arm would authorise.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9459#issuecomment-5745160952
 */
export const plan = (facts: WorktreeFacts): SyncPlan => {
	if (facts.branch === null) {
		return {
			_tag: "Refused",
			reason: `the plugin source's primary worktree is on a detached HEAD at ${short(facts.head)}, not on ${facts.defaultBranch}`,
		};
	}
	if (facts.branch !== facts.defaultBranch) {
		return {
			_tag: "Refused",
			reason: `the plugin source's primary worktree is on ${facts.branch}, not on ${facts.defaultBranch}`,
		};
	}
	if (facts.head === facts.remoteHead) {
		return {_tag: "Current", branch: facts.branch, commit: facts.head};
	}
	const clobbered = clobberedPaths(facts);
	if (clobbered.length > 0) {
		return {
			_tag: "Refused",
			reason: `the plugin source's primary worktree carries uncommitted changes the incoming commits also change (${quotePaths(clobbered)}), so ${facts.branch} cannot be fast-forwarded to origin/${facts.defaultBranch}`,
		};
	}
	if (!facts.fastForwardable) {
		return {
			_tag: "Refused",
			reason: `${facts.branch} at ${short(facts.head)} has diverged from origin/${facts.defaultBranch} at ${short(facts.remoteHead)} — only a fast-forward is taken here`,
		};
	}
	return {_tag: "FastForward", branch: facts.branch, from: facts.head, to: facts.remoteHead};
};

/**
 * The uncommitted paths the incoming commits also change — the set a fast-forward would write over.
 *
 * This is the whole narrowing: `git merge --ff-only` refuses on exactly this overlap and takes the
 * move otherwise, so a dirty path the incoming commits never touch is not a reason to leave the
 * plugin source behind. An untracked file sits in {@link WorktreeFacts.dirtyPaths} like any other,
 * so a path an incoming commit would create over one lands here and is refused — that clobber is
 * what the blanket refusal used to buy.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9459#issuecomment-5745160952
 */
export const clobberedPaths = (facts: WorktreeFacts): ReadonlyArray<string> => {
	const incoming = new Set(facts.incomingPaths);
	return [...new Set(facts.dirtyPaths.filter((path) => incoming.has(path)))].sort();
};

/** How many overlapping paths a refusal names before it counts the rest. */
const QUOTED_PATHS = 3;

const quotePaths = (paths: ReadonlyArray<string>): string => {
	const rest = paths.length - QUOTED_PATHS;
	const shown = paths.slice(0, QUOTED_PATHS).join(", ");
	return rest > 0 ? `${shown} and ${rest} more` : shown;
};

/** The entries of a NUL-separated git list, with the trailing terminator's empty tail dropped. */
const nulFields = (out: string): ReadonlyArray<string> =>
	out.split("\0").filter((field) => field !== "");

/** Every path a `git diff --name-only -z` answer names. */
export const changedPathsIn = (diff: string): ReadonlyArray<string> => nulFields(diff);

/**
 * Every path a `git status --porcelain -z --untracked-files=all` answer names.
 *
 * `-z` rather than the quoted default because a path holding a space or a non-ASCII byte comes back
 * quoted and escaped otherwise, and a path that does not survive the read compares against nothing.
 * A rename's record carries its origin path as the following field, and both ends count: the
 * incoming commits can collide with either.
 */
export const dirtyPathsIn = (status: string): ReadonlyArray<string> => {
	const fields = nulFields(status);
	const paths: string[] = [];
	for (let at = 0; at < fields.length; at += 1) {
		const field = fields[at] ?? "";
		if (field.length < 4) continue;
		paths.push(field.slice(3));
		const origin = fields[at + 1];
		if ((field[0] === "R" || field[0] === "C") && origin !== undefined) {
			paths.push(origin);
			at += 1;
		}
	}
	return paths;
};

/** A commit id at the width every fabrika diagnostic quotes one. */
export const short = (commit: string): string => commit.slice(0, 12);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

/**
 * The marketplaces whose source is this exact directory.
 *
 * Matched on the declared `source.path` and not on `installLocation`: the path is what the operator
 * registered, and it is the field that survives the harness re-materialising its own cache. A
 * marketplace on any other source kind — a forge repository, an archive — is not served by moving a
 * local checkout, so it contributes no row and this verb has nothing to say about it.
 *
 * Tolerant of shape on purpose, exactly as `./declaration.ts` is: an unreadable record yields no
 * rows, and every caller must read zero rows as "nothing proven", never as "nothing to do".
 */
export const directoryMarketplacesAt = (
	document: unknown,
	directory: string,
): ReadonlyArray<string> => {
	const root = asRecord(document);
	if (root === undefined) return [];
	const names: string[] = [];
	for (const [name, entry] of Object.entries(root)) {
		const record = asRecord(entry);
		const source = record === undefined ? undefined : asRecord(record.source);
		if (source === undefined || source.source !== "directory") continue;
		if (typeof source.path === "string" && source.path === directory) names.push(name);
	}
	return names.sort();
};

/** One installed plugin and the commit of the source directory its copy was taken from. */
export interface InstallBinding {
	readonly pluginId: string;
	readonly commit: string;
	/** How many scope records share this binding. Several old worktrees pin one long-dead copy. */
	readonly records: number;
}

/**
 * Every distinct binding taken from one of the named marketplaces — one row per plugin and commit.
 *
 * One plugin yields several rows on purpose. The harness records an install per scope, and a
 * project-scoped row can sit at a different commit than the user-scoped one — which is precisely the
 * state where a session binds a stale copy while another session on the same machine binds a current
 * one. Collapsing them to a single "the install" would hide the disagreement that *is* the defect.
 *
 * What is folded is the *repetition*, not the disagreement: a machine accumulates a scope record per
 * throwaway worktree it ever opened, so one long-dead copy can be named a dozen times over. Those
 * are one binding, and {@link InstallBinding.records} keeps the count so nothing is dropped silently.
 *
 * An install whose record carries no `gitCommitSha` contributes no row: an absent commit is not a
 * commit to compare, and reporting it as one would state a lag nothing measured.
 */
export const installsFrom = (
	document: unknown,
	marketplaces: ReadonlyArray<string>,
): ReadonlyArray<InstallBinding> => {
	const root = asRecord(document);
	const plugins = root === undefined ? undefined : asRecord(root.plugins);
	if (plugins === undefined) return [];
	const owned = new Set(marketplaces);
	const counted = new Map<string, InstallBinding>();
	for (const [pluginId, entries] of Object.entries(plugins)) {
		const marketplace = pluginId.slice(pluginId.lastIndexOf("@") + 1);
		if (!owned.has(marketplace) || !Array.isArray(entries)) continue;
		for (const entry of entries) {
			const record = asRecord(entry);
			if (record === undefined || typeof record.gitCommitSha !== "string") continue;
			const commit = record.gitCommitSha;
			const key = `${pluginId} ${commit}`;
			const seen = counted.get(key);
			counted.set(key, {pluginId, commit, records: (seen?.records ?? 0) + 1});
		}
	}
	return [...counted.values()];
};

/**
 * What the installs say about the commit the source directory now sits at.
 *
 * `bound` is the only state in which a change that landed on the source's default branch reaches the
 * next spawned shell. `lagging` names every install still copied from an earlier commit, and it is
 * reported rather than acted on: re-copying is the harness's `autoUpdate` pass, which runs at its own
 * moments and which no verb in this package drives. `unknown` is the honest answer when the records
 * could not be read at all — never `bound`, since an unread record proves nothing.
 */
export type InstallReport =
	| {readonly _tag: "Bound"; readonly rows: ReadonlyArray<InstallBinding>}
	| {readonly _tag: "Lagging"; readonly rows: ReadonlyArray<InstallBinding>}
	| {readonly _tag: "Unknown"; readonly reason: string};

/** Fold the bindings against the commit the source directory is at once this verb is done with it. */
export const reportInstalls = (
	rows: ReadonlyArray<InstallBinding>,
	sourceCommit: string,
): InstallReport => {
	if (rows.length === 0) {
		return {
			_tag: "Unknown",
			reason: "no install record names a plugin taken from this directory",
		};
	}
	const lagging = rows.filter((row) => row.commit !== sourceCommit);
	return lagging.length === 0
		? {_tag: "Bound", rows}
		: {_tag: "Lagging", rows: [...lagging].sort((a, b) => b.records - a.records)};
};
