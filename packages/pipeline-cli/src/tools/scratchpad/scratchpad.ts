/**
 * `scratchpad` pure core — resolve the per-run scratch namespace an agent writes
 * intermediate state into, and decide who owns it. IO-free and total; the filesystem
 * boundary lives in `store.ts`, the CLI surface in `command.ts`.
 *
 * The whole point is that a scratch path is unique per RUN, never per session or per
 * tool: the pipeline runs several agents concurrently by design, so a fixed or
 * work-item-keyed leaf name is a shared mutable surface. A clobbered file reads back
 * SUCCESSFULLY with the other run's content — no error to catch — which is how one
 * reviewer's `git diff` returned another PR's file list, and how a `review-doc` verdict
 * body computed for one PR was posted-attempted against another (#3718). See the
 * gh-issue-intake-formats.md §SP contract this core owns the mechanics of.
 *
 * Two properties are BOTH required, and a namespace with only one is broken:
 *   - per-run uniqueness — concurrent runs must not be able to name each other's files;
 *   - deterministic re-derivability — an agent's shell state does not survive between
 *     Bash calls, so a later call must recompute the same path from scratch (which a
 *     bare `mktemp -d` destroys: re-running it yields a new empty directory).
 *
 * The path key delivers both: `<tmpdir>/kampus-run/<session-id>/<slug>`. The OWNER STAMP
 * (`.kampus-run-owner`) covers the remaining case — two runs that resolve the SAME path.
 * The stamp is not a marker the store checks and then acts on: it is created exclusively
 * (`store.ts`, `wx`), so among concurrent opens exactly one run wins and every run the
 * stamp identifies as another is refused with `ForeignNamespace` rather than clobbering,
 * and a re-derive refuses to read a namespace another run holds. The one pair the stamp
 * cannot separate is two runs whose identity is byte-identical (same session id AND same
 * `$CLAUDE_PID`, or neither carrying one) — nothing in the environment distinguishes them,
 * so the loser re-enters instead of being refused. It is never destructive: a re-entered
 * namespace is returned as it stands, never cleared.
 */

/** The directory segment that marks a per-run namespace, under the system temp root. */
export const RUN_SCRATCH_ROOT = "kampus-run";

/** The owner-stamp file written at the root of every allocated namespace. */
export const OWNER_FILE = ".kampus-run-owner";

/**
 * Who owns a namespace. `session` is `$CLAUDE_CODE_SESSION_ID`, the per-agent-run UUID
 * the runtime exports (the same token ADR 0115's claim protocol stamps) — stable across
 * an agent's separate Bash calls, distinct per agent run. `pid` is `$CLAUDE_PID`, an
 * extra discriminator when it is available; `null` when the environment omits it.
 */
export interface RunIdentity {
	readonly session: string;
	readonly pid: string | null;
}

/** The inputs a namespace is resolved from — all read from the environment by the caller. */
export interface NamespaceInput {
	/** `$TMPDIR`; a missing value falls back to `/tmp`, the POSIX default. */
	readonly tmpdir?: string | undefined;
	/** `$CLAUDE_CODE_SESSION_ID`. Absent ⇒ `MissingSessionId`, never a shared-path fallback. */
	readonly session?: string | undefined;
	/** `$CLAUDE_PID`. Absent is fine — it only sharpens ownership, it is not the key. */
	readonly pid?: string | undefined;
	/** Names the caller: the skill plus its work item (`review-doc-3951`, `write-code-3718`). */
	readonly slug: string;
}

/** A resolved namespace: where it lives, its owner stamp, and the identity that owns it. */
export interface Namespace {
	readonly path: string;
	readonly ownerFile: string;
	readonly identity: RunIdentity;
}

/**
 * Every way resolving or claiming a namespace can fail. Each one is a REFUSAL: there is
 * no fallback to a shared or default location, because such a fallback resurrects the
 * exact silent clobber this tool exists to remove (ADR 0092, fail closed).
 */
export type ScratchpadError =
	| {readonly _tag: "MissingSessionId"; readonly message: string}
	| {readonly _tag: "InvalidSlug"; readonly slug: string; readonly message: string}
	| {readonly _tag: "InvalidLeafName"; readonly name: string; readonly message: string}
	| {
			readonly _tag: "ForeignNamespace";
			readonly path: string;
			readonly owner: RunIdentity;
			readonly mine: RunIdentity;
			readonly message: string;
	  }
	| {readonly _tag: "NamespaceMissing"; readonly path: string; readonly message: string}
	| {readonly _tag: "NamespaceUnavailable"; readonly path: string; readonly message: string};

/** A total result: the value, or the typed refusal. Nothing throws, nothing falls back. */
export type Resolved<A> =
	| {readonly ok: true; readonly value: A}
	| {readonly ok: false; readonly error: ScratchpadError};

export const ok = <A>(value: A): Resolved<A> => ({ok: true, value});
export const fail = <A>(error: ScratchpadError): Resolved<A> => ({ok: false, error});

/**
 * A slug names the caller, so it must be a single readable path segment. Rejecting
 * separators and dot-segments is not cosmetic: a slug that escapes its directory would
 * let one run address another run's namespace, which is the property being enforced.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** A leaf file name inside a namespace — same segment rule, so `../` can never appear. */
const LEAF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const trimmed = (value: string | undefined): string => (value ?? "").trim();

export const validateSlug = (slug: string): Resolved<string> => {
	const value = trimmed(slug);
	if (value === "")
		return fail({
			_tag: "InvalidSlug",
			slug,
			message: "slug is empty — name the caller (skill + work item, e.g. `review-doc-3951`)",
		});
	if (value === "." || value === ".." || !SLUG_RE.test(value))
		return fail({
			_tag: "InvalidSlug",
			slug,
			message: `slug ${JSON.stringify(slug)} is not a single lowercase path segment ([a-z0-9][a-z0-9._-]*) — a separator or dot-segment would let one run address another run's namespace`,
		});
	return ok(value);
};

export const validateLeafName = (name: string): Resolved<string> => {
	const value = trimmed(name);
	if (value === "" || value === "." || value === ".." || !LEAF_RE.test(value))
		return fail({
			_tag: "InvalidLeafName",
			name,
			message: `file name ${JSON.stringify(name)} is not a single path segment ([A-Za-z0-9][A-Za-z0-9._-]*) — keep the leaf plain; uniqueness lives in the directory`,
		});
	return ok(value);
};

/** The system temp root a namespace hangs under; `/tmp` is the POSIX default. */
export const tempRoot = (tmpdir: string | undefined): string => {
	const value = trimmed(tmpdir);
	return value === "" ? "/tmp" : value.replace(/\/+$/, "");
};

/**
 * Resolve the namespace for this run. Deterministic: the same environment plus the same
 * slug recomputes the same path in any later Bash call, which is what lets a caller
 * re-derive instead of parking the path in another file (that would just relocate the
 * collision onto that file).
 */
export const resolveNamespace = (input: NamespaceInput): Resolved<Namespace> => {
	const session = trimmed(input.session);
	if (session === "")
		return fail({
			_tag: "MissingSessionId",
			message:
				"CLAUDE_CODE_SESSION_ID is unset — there is no run identity to namespace under, and a shared-path fallback would resurrect the cross-run clobber (#3718). Refusing.",
		});
	const slug = validateSlug(input.slug);
	if (!slug.ok) return slug;
	const pid = trimmed(input.pid);
	const path = `${tempRoot(input.tmpdir)}/${RUN_SCRATCH_ROOT}/${session}/${slug.value}`;
	return ok({
		path,
		ownerFile: `${path}/${OWNER_FILE}`,
		identity: {session, pid: pid === "" ? null : pid},
	});
};

/** The owner stamp written into a freshly-opened namespace. */
export const formatOwner = (identity: RunIdentity, openedAt: string): string =>
	`${JSON.stringify({session: identity.session, pid: identity.pid, openedAt})}\n`;

/** Read an owner stamp back. Anything unparseable is `null` — an unreadable stamp is not an owner. */
export const parseOwner = (text: string): RunIdentity | null => {
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return null;
		const record = parsed as {session?: unknown; pid?: unknown};
		if (typeof record.session !== "string" || record.session.trim() === "") return null;
		const pid =
			typeof record.pid === "string" && record.pid.trim() !== "" ? record.pid.trim() : null;
		return {session: record.session.trim(), pid};
	} catch {
		return null;
	}
};

/** How an existing namespace relates to the run asking for it. */
export type Ownership = "unowned" | "mine" | "foreign";

/**
 * Fail-closed by construction: only positive evidence that the stamp names THIS run
 * resolves `mine`. A same-session stamp carrying a different pid is `foreign` — that is
 * precisely the two-concurrent-runs-share-a-session case, and calling it mine is what a
 * silent clobber looks like.
 */
export const classifyOwnership = (existing: RunIdentity | null, mine: RunIdentity): Ownership => {
	if (existing === null) return "unowned";
	if (existing.session !== mine.session) return "foreign";
	if (existing.pid === null && mine.pid === null) return "mine";
	return existing.pid === mine.pid ? "mine" : "foreign";
};

export const foreignNamespaceError = (
	path: string,
	owner: RunIdentity,
	mine: RunIdentity,
): ScratchpadError => ({
	_tag: "ForeignNamespace",
	path,
	owner,
	mine,
	message: `the namespace is owned by another run (owner session ${owner.session} pid ${owner.pid ?? "-"}; mine ${mine.session} pid ${mine.pid ?? "-"}) — refusing to clobber or read it. Re-run with a run-distinguishing --slug.`,
});

/** The process exit code each refusal maps to, so a caller can branch without parsing prose. */
export const exitCodeFor = (error: ScratchpadError): number => {
	switch (error._tag) {
		case "MissingSessionId":
			return 2;
		case "InvalidSlug":
		case "InvalidLeafName":
			return 3;
		case "ForeignNamespace":
			return 4;
		case "NamespaceMissing":
			return 5;
		case "NamespaceUnavailable":
			return 6;
	}
};
