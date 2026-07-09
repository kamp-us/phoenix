/**
 * `ref-guard` pure core — decide whether a `reference-transaction` update to the
 * shared primary checkout's `refs/heads/main` is safe, given the already-gathered
 * git facts. IO-free and total: a deterministic transform over a queued ref update
 * plus the ancestry fact the git boundary computed. The git boundary (read stdin,
 * resolve `origin/main`, run `merge-base --is-ancestor`) lives in `command.ts`; this
 * module never runs a command.
 *
 * The problem it codifies (#2143 root cause): the orchestrator/PULLER role force-moved
 * the shared primary checkout's `main` ref off the merge seam — a bare
 * `branch -f main` / `checkout -B main` / `update-ref refs/heads/main` / `push HEAD:main`
 * that landed `main` on a stranding commit DIVERGED from `origin/main` (not a
 * fast-forward), with a ~13.5k-line deletion staged — a "one `git push -f` clobbers
 * `origin/main`" loaded gun. The #1571 `worktree-guard` bash-pin can't reach this
 * class on three counts (the offender has no `$WORKTREE_ROOT`; a ref force-move is not
 * in its `HEAD_MOVING` set; the keystroke is outside the agent Bash tool-call path).
 * A `reference-transaction` hook sits at git's OWN ref boundary, so it catches ANY
 * caller — agent Bash, harness worktree machinery, a manually-run command, or another
 * git hook — which a `PreToolUse` Bash hook cannot.
 *
 * The safety property (#2143 AC): a `refs/heads/main` update that would make local
 * `main` a NON-fast-forward of `origin/main` (a divergence) is REFUSED; the legitimate
 * PULLER flow — `checkout main` reattach (no ref move on `main`) + `merge --ff-only
 * origin/main` (a fast-forward ⇒ `origin/main` is an ancestor of the new tip) — is
 * ALLOWED. The core refuses only the diverging move, never the sync.
 *
 * Fail-safe posture (fail-closed on the guarded ref, fail-open off it): every
 * indeterminate fact the git boundary can't resolve is passed as a discriminated flag
 * so the decision is explicit, never a silent allow of a `main` divergence.
 *
 * A second, orthogonal concern lives here too (#2270, the mechanical half): `decideHeadDetach`
 * refuses a bare HEAD-detaching checkout on the shared PRIMARY checkout — a distinct hazard from
 * the `refs/heads/main` force-move above, and one `decideRefUpdate` structurally cannot see (a
 * detach moves `HEAD`, not `refs/heads/main`). See its docblock for the git-grounded signal.
 */

/** The full ref name the guard protects. Other refs (feature branches, tags, `origin/*`) are out of scope. */
export const GUARDED_REF = "refs/heads/main";

/**
 * Git's per-worktree symbolic `HEAD`, as it appears verbatim on the `reference-transaction`
 * stdin (`<old> SP <new> SP HEAD`). A detaching checkout moves THIS ref to a concrete commit —
 * the operation `decideHeadDetach` guards on the primary checkout.
 */
export const HEAD_REF = "HEAD";

/**
 * The prefix git ≥ 2.45 stamps on a SYMREF value in a `reference-transaction` line when the update
 * retargets a symbolic ref rather than moving it to an object — e.g. reattaching HEAD queues
 * `<old> SP ref:refs/heads/main SP HEAD`. Grounded by direct measurement on git 2.55 (below); it is
 * the signal that a HEAD update is an ATTACH (reattach / branch switch), never a detach.
 */
export const SYMREF_VALUE_PREFIX = "ref:";

/** A `reference-transaction` value naming a symbolic-ref target (`ref:refs/…`) rather than an object id. */
const isSymrefValue = (value: string): boolean => value.startsWith(SYMREF_VALUE_PREFIX);

/** Git's all-zeroes object name — the sentinel for a ref being created anew (old) or deleted (new). */
export const ZERO_OID = "0000000000000000000000000000000000000000";

/**
 * A single queued reference update, as the `reference-transaction` hook receives it on
 * stdin — `<old-value> SP <new-value> SP <ref-name>`. `oldOid`/`newOid` are the raw
 * object names (either may be `ZERO_OID`: an all-zeroes `newOid` is a delete, an
 * all-zeroes `oldOid` is a create/force).
 */
export interface RefUpdate {
	readonly oldOid: string;
	readonly newOid: string;
	readonly refName: string;
}

/**
 * The ancestry fact the git boundary resolves for a guarded update, reduced to exactly
 * what the decision needs. Every field fails safe toward REFUSE on the guarded ref: an
 * unresolvable `origin/main` or an indeterminate ancestry probe reads as "cannot prove a
 * fast-forward", which — for `refs/heads/main` — is a refusal, never a silent allow.
 */
export interface OriginFacts {
	/**
	 * `origin/main` resolved to a concrete OID, or `null` when the remote-tracking ref is
	 * absent/unresolvable. `null` ⇒ there is nothing to diverge FROM — see `decideRefUpdate`
	 * for why that is an ALLOW (a fresh clone with no `origin/main` yet has no divergence to
	 * guard), not a refuse.
	 */
	readonly originMainOid: string | null;
	/**
	 * `true` iff `origin/main` is an ancestor of (or equal to) the update's `newOid` —
	 * i.e. the new `main` tip is a fast-forward of `origin/main`. Resolved by the boundary
	 * with `git merge-base --is-ancestor origin/main <newOid>`. An indeterminate probe
	 * (command failed) MUST be passed as `false` (fail-safe: cannot prove ff ⇒ treat as
	 * divergence on the guarded ref).
	 */
	readonly originIsAncestorOfNew: boolean;
}

/**
 * The verdict for one queued ref update. `allow` proceeds; `refuse` (only ever on
 * `GUARDED_REF`) aborts the whole `reference-transaction` in the `prepared` state.
 */
export type RefDecision =
	| {readonly kind: "allow"; readonly reason: string}
	| {readonly kind: "refuse"; readonly reason: string};

/**
 * Decide whether a queued `reference-transaction` update is safe:
 *
 *   1. NOT `refs/heads/main` → `allow`. The guard is scoped to the one shared-primary ref;
 *      every feature branch, tag, and `origin/*` update passes untouched. (Worktree agents
 *      only ever move their OWN branch refs, so they never reach the guarded path.)
 *   2. `refs/heads/main` DELETE (`newOid` all-zeroes) → `refuse`. Deleting the primary's
 *      `main` is never a legitimate PULLER op and is a divergence in the extreme.
 *   3. `refs/heads/main`, `origin/main` unresolvable → `allow`. With no `origin/main` there
 *      is nothing to diverge from (a fresh clone before the first fetch); refusing here would
 *      wedge legitimate setup. This is the ONE fail-OPEN on the guarded ref, safe precisely
 *      because the divergence the guard exists to catch is undefined without an origin.
 *   4. `refs/heads/main`, new tip == `origin/main` → `allow`. In-sync (e.g. a reset/reattach
 *      landing exactly on `origin/main`); trivially a fast-forward.
 *   5. `refs/heads/main`, `origin/main` IS an ancestor of the new tip → `allow`. A
 *      fast-forward-ahead: the legitimate `merge --ff-only origin/main` and any `main` advance
 *      that carries `origin/main`'s history forward.
 *   6. `refs/heads/main`, `origin/main` is NOT an ancestor of the new tip → `refuse`. The
 *      #2143 non-fast-forward divergence: `main` would leave `origin/main`'s history, the exact
 *      loaded-gun state. Fail-closed.
 *
 * Total over every `RefUpdate` × `OriginFacts`. The order above is the policy: the ref-scope
 * check gates first (off-`main` never touches origin facts), then delete, then the origin-absent
 * fail-open, then the two fast-forward allows, then the divergence refuse.
 */
export const decideRefUpdate = (update: RefUpdate, facts: OriginFacts): RefDecision => {
	if (update.refName !== GUARDED_REF) {
		return {kind: "allow", reason: `${update.refName} is not the guarded ref (${GUARDED_REF})`};
	}
	if (update.newOid === ZERO_OID) {
		return {
			kind: "refuse",
			reason: `refusing to DELETE ${GUARDED_REF} on the shared primary checkout — never a legitimate sync op (#2143)`,
		};
	}
	if (facts.originMainOid === null) {
		return {
			kind: "allow",
			reason: `origin/main is unresolvable — no origin to diverge from, allowing ${GUARDED_REF} update`,
		};
	}
	if (update.newOid === facts.originMainOid) {
		return {kind: "allow", reason: `${GUARDED_REF} new tip == origin/main (in sync)`};
	}
	if (facts.originIsAncestorOfNew) {
		return {
			kind: "allow",
			reason: `${GUARDED_REF} update is a fast-forward of origin/main (origin/main is an ancestor of the new tip)`,
		};
	}
	return {
		kind: "refuse",
		reason:
			`refusing a DIVERGING ${GUARDED_REF} update on the shared primary checkout: the new tip ${update.newOid.slice(0, 12)} ` +
			`is NOT a fast-forward of origin/main (${facts.originMainOid.slice(0, 12)}) — this is the #2143 loaded-gun state ` +
			`(local main diverged from origin/main; one \`git push -f\` would clobber origin/main). Drive sync through ` +
			`\`git merge --ff-only origin/main\`, never a bare \`branch -f main\` / \`checkout -B main\` / \`update-ref refs/heads/main\`.`,
	};
};

/**
 * The checkout a `reference-transaction` is firing against, reduced to the one fact the
 * HEAD-detach decision needs: whether it is the shared PRIMARY checkout rather than a linked
 * worktree. The git boundary resolves it by comparing the per-tree git-dir with the shared
 * git-common-dir (equal ⇒ primary; differ ⇒ linked worktree — the same plumbing `write-code`'s
 * worktree preflight uses). An indeterminate resolution passes `false` (fail-OPEN: a detach we
 * can't prove is on the primary is allowed, so a worktree agent is never false-refused).
 */
export interface CheckoutContext {
	readonly isPrimaryCheckout: boolean;
}

/**
 * Refuse a bare HEAD-detaching checkout on the shared PRIMARY checkout — the #2270 hazard: a
 * worktree-isolated agent whose cwd resets to the primary between Bash calls runs a bare
 * `git checkout <sha>` / `checkout FETCH_HEAD` / `switch --detach`, detaching the human's shared
 * `HEAD` off its branch and corrupting the checkout. `decideRefUpdate`'s `refs/heads/main` scope
 * never sees this: a detach moves `HEAD`, not `refs/heads/main`, so it is a separate decision.
 *
 * The signal is grounded in git's real `reference-transaction` behavior, measured directly on BOTH
 * deployed git versions — local 2.40.1 AND CI/production 2.55.0 (git changed HEAD emission between
 * them: the symref-in-transaction work of git 2.45; #2415/#2270 regrounding). A detaching checkout
 * (`checkout <sha>` / `switch --detach`) queues, in the `prepared` state, an update whose ref-name
 * is exactly `HEAD` and whose NEW VALUE is a CONCRETE object id — identical on 2.40 and 2.55. The
 * two legitimate look-alikes differ by version, and BOTH must be allowed:
 *   - a REATTACH / branch switch (`checkout main`, `switch <branch>`) queues, on git ≥ 2.45, a HEAD
 *     update whose new value is the SYMREF `ref:refs/heads/<branch>` (not an object) — and on 2.40
 *     queues no `HEAD` update at all. `isSymrefValue` catches the ≥2.45 form; the 2.40 form has no
 *     line to catch. Either way: never a detach.
 *   - an ATTACHED commit/reset on the current branch queues, on 2.40, `HEAD` PAIRED with its
 *     `refs/heads/<branch>` update to the SAME new oid; on 2.55 the `prepared` batch carries only
 *     the `refs/heads/<branch>` line (no HEAD). The `branchTargets` pairing catches the 2.40 form.
 * So a detach is exactly: a HEAD update to a concrete oid that is NEITHER a symref value NOR paired
 * with a same-oid branch move in the batch. This isolates a detach on both versions, and only a
 * detach — never the reattach the shared-primary PULLER relies on.
 *
 * Scoped to the PRIMARY checkout (`ctx.isPrimaryCheckout`). A worktree's own HEAD detach fires
 * against its per-tree git-dir, so this allows it — worktree agents moving/detaching their OWN
 * HEAD are untouched, as are the PULLER `checkout main` reattach and the human's normal attached
 * work.
 */
export const decideHeadDetach = (
	updates: ReadonlyArray<RefUpdate>,
	ctx: CheckoutContext,
): RefDecision => {
	if (!ctx.isPrimaryCheckout) {
		return {
			kind: "allow",
			reason:
				"not the shared primary checkout (a linked worktree) — HEAD moves are the worktree's own",
		};
	}
	const branchTargets = new Set(
		updates
			.filter((u) => u.refName.startsWith("refs/heads/") && u.newOid !== ZERO_OID)
			.map((u) => u.newOid),
	);
	for (const u of updates) {
		if (u.refName !== HEAD_REF) continue;
		if (u.newOid === ZERO_OID) continue; // a HEAD delete / no concrete target is not a detach
		if (isSymrefValue(u.newOid)) continue; // HEAD retargeted to a branch (ref:refs/heads/*) ⇒ reattach/switch, allow (git ≥ 2.45)
		if (branchTargets.has(u.newOid)) continue; // paired with a branch move ⇒ attached, allow (git 2.40)
		return {
			kind: "refuse",
			reason:
				`refusing a HEAD-detaching checkout on the shared PRIMARY checkout: HEAD would move to ${u.newOid.slice(0, 12)} ` +
				`with no branch tracking it (a detached HEAD). On the primary this strands the human's shared checkout off its ` +
				`branch (#2270) — the exact corruption a worktree-isolated agent triggers when its cwd resets to the primary ` +
				`between calls. Detach inside your OWN worktree, or reattach with \`git checkout <branch>\`, never a bare ` +
				`\`git checkout <sha>\` / \`checkout FETCH_HEAD\` / \`switch --detach\` on the primary.`,
		};
	}
	return {kind: "allow", reason: "no bare HEAD detach on the primary checkout"};
};

/**
 * Reduce a batch of queued updates to a single transaction verdict: the transaction is
 * REFUSED iff ANY update in it is refused (a `reference-transaction` is all-or-nothing —
 * a non-zero exit in the `prepared` state aborts the WHOLE transaction, not one ref). The
 * refuse reason surfaced is the first refused update's, so the operator sees the guarded-ref
 * divergence that triggered the abort. An empty batch (no updates queued) is a clean allow.
 */
export const decideTransaction = (decisions: ReadonlyArray<RefDecision>): RefDecision => {
	for (const d of decisions) {
		if (d.kind === "refuse") return d;
	}
	return {kind: "allow", reason: "no guarded-ref divergence in the transaction"};
};
