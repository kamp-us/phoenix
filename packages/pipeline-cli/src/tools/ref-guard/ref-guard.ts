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
 */

/** The full ref name the guard protects. Other refs (feature branches, tags, `origin/*`) are out of scope. */
export const GUARDED_REF = "refs/heads/main";

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
