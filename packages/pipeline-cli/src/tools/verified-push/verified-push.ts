/**
 * `verified-push` pure core — decide whether a push actually landed the ref, given the
 * already-gathered facts. IO-free and total; the git boundary (running the push, running
 * the `ls-remote` probe) lives in `command.ts`.
 *
 * Why this exists (#4213, the remedy half of #4146): push success was *inferred* rather
 * than observed, through two masking layers that are not git's fault at all —
 *
 *   1. `git push … | tail -N` reports `tail`'s status. `pipefail` is off on this platform
 *      (measured, not assumed), so the pipeline returns 0 however git died.
 *   2. A detached run's output file carries **no exit status at all**, so success gets
 *      inferred from the absence of an `error:` line — and a SIGPIPE'd git prints nothing,
 *      which is exactly what that absence looks like.
 *
 * Both layers destroy the *exit code*, so an exit-code-only verdict defeats neither. The
 * one channel that survives a pipe **and** a detached output-file read is **stdout**, so
 * the verdict is a single grep-able TERMINAL LINE emitted last on stdout, in addition to
 * the exit code. `tail -1` now *preserves* the verdict instead of erasing it.
 *
 * And even an unmasked exit status answers "did the process fail", not "did the ref move".
 * The ref is the fact every downstream stage assumes (reviewer checkout, SHA-bound verdict,
 * shipper merge), so the verdict is decided by an independent read of the remote ref, never
 * by the push's own self-report.
 *
 * Three outcomes, never two — `moved` / `not-moved` / `unknown`. `unknown` never collapses
 * into success: only positive evidence (the remote ref resolved, and it carries the exact
 * local head) yields `moved`. A probe that could not execute is `unknown`, never a pass and
 * never a fail.
 *
 * **No retry, deliberately.** A blind re-push would have "worked" for the #4042 lane and
 * would have buried #4136's transport mechanism, making the real defect harder to find — the
 * contention this verb exists to expose would be silently absorbed. Retrying is also unsound
 * on its own terms here: the verb cannot distinguish a transient transport death from a
 * rejected non-fast-forward, so a retry loop would hammer a legitimately refused push. The
 * caller decides what to do with a `not-moved`/`unknown`; this verb only reports it.
 */

/** The three outcomes. `unknown` is a first-class result, never a degraded success. */
export type PushOutcome = "moved" | "not-moved" | "unknown";

/**
 * The single grep-able token per outcome, emitted as the LAST line on stdout. Callers (and
 * the write-code skill) match on `PUSH-VERDICT: <TOKEN>`; keep these stable — they are the
 * wire format, not a log string.
 */
export const VERDICT_PREFIX = "PUSH-VERDICT:";

export const VERDICT_TOKEN: Readonly<Record<PushOutcome, string>> = {
	moved: "MOVED",
	"not-moved": "NOT-MOVED",
	unknown: "UNKNOWN",
};

/**
 * Exit codes, distinct per outcome so a caller that *does* read the status can tell a real
 * failure from an indeterminate one. `unknown` gets its own code (3, the repo's established
 * "dedicated, not 1" convention — see `ref-guard`'s `REFUSE_EXIT_CODE`) so it can never be
 * mistaken for the ordinary failure path, and 0 is reserved for a *confirmed* landed ref.
 */
export const EXIT_CODE: Readonly<Record<PushOutcome, number>> = {
	moved: 0,
	"not-moved": 1,
	unknown: 3,
};

/** What the `git push` process reported. `exitCode: null` = it could not be determined. */
export interface PushAttempt {
	readonly exitCode: number | null;
	/** The signal that killed the push (`SIGPIPE`, …), or `null`. */
	readonly signal: string | null;
}

/**
 * The independent, read-only remote-ref probe. `failed` is the honest third state: the probe
 * could not execute (no transport, timed out, unparseable output), which is *unknown* — never
 * "the ref is absent", which is a positive claim the probe did not establish.
 */
export type RefProbe =
	| {readonly kind: "resolved"; readonly sha: string}
	| {readonly kind: "absent"}
	| {readonly kind: "failed"; readonly detail: string};

/**
 * The gathered facts. `not-attempted` covers everything that went wrong *before* the push
 * could be issued (cwd is not a repo, detached HEAD, unresolvable local head) — all of which
 * are `unknown` rather than failure: nothing was pushed, so nothing about the remote is known.
 */
export type PushFacts =
	| {readonly kind: "not-attempted"; readonly detail: string}
	| {
			readonly kind: "attempted";
			readonly remote: string;
			/** The full remote ref the push targeted, e.g. `refs/heads/umut/foo`. */
			readonly ref: string;
			/** The local commit the push was supposed to land. */
			readonly expectedSha: string;
			readonly attempt: PushAttempt;
			/** The remote ref as read back AFTER the push, independently of the push's own report. */
			readonly after: RefProbe;
	  };

export interface PushVerdict {
	readonly outcome: PushOutcome;
	/** One line, no newlines — it is embedded in the terminal line. */
	readonly reason: string;
	/** The exact last-line-on-stdout the caller greps. */
	readonly terminalLine: string;
	readonly exitCode: number;
}

/** Collapse to a single line: the terminal line must be greppable as ONE line, always. */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** `git ls-remote` prints `<sha>\t<ref>` per matching ref; `""` means the ref does not exist. */
export const parseLsRemote = (stdout: string, ref: string): string | null => {
	for (const line of stdout.split("\n")) {
		const [sha, name] = line.trim().split(/\s+/);
		if (name === ref && sha !== undefined && /^[0-9a-f]{40}$/.test(sha)) return sha;
	}
	return null;
};

/** A push that neither exited 0 nor is even known to have exited — anything but a clean run. */
const attemptIsClean = (a: PushAttempt): boolean => a.exitCode === 0 && a.signal === null;

const describeAttempt = (a: PushAttempt): string =>
	a.signal !== null
		? `git push was killed by ${a.signal}`
		: a.exitCode === null
			? "git push's exit status could not be determined"
			: `git push exited ${a.exitCode}`;

const verdict = (
	outcome: PushOutcome,
	reason: string,
	ctx: {readonly where: string; readonly observed: string} | null,
): PushVerdict => {
	const body = ctx === null ? "" : ` ${ctx.where} observed=${ctx.observed}`;
	const line = oneLine(`${VERDICT_PREFIX} ${VERDICT_TOKEN[outcome]}${body} — ${reason}`);
	return {outcome, reason: oneLine(reason), terminalLine: line, exitCode: EXIT_CODE[outcome]};
};

/**
 * The whole decision. Ordered so that every path to `moved` requires POSITIVE evidence —
 * the probe resolved AND it carries the expected sha AND the push itself ran cleanly. Every
 * indeterminate fact routes to `unknown`; only a probe that positively established the remote
 * ref is somewhere other than the local head yields `not-moved`.
 */
export const decidePush = (facts: PushFacts): PushVerdict => {
	if (facts.kind === "not-attempted") {
		return verdict("unknown", `no push was attempted — ${facts.detail}`, null);
	}

	const {remote, ref, expectedSha, attempt, after} = facts;
	const where = `remote=${remote} ref=${ref} expected=${expectedSha}`;

	if (after.kind === "failed") {
		// The probe could not execute. This is the case the whole third outcome exists for:
		// the push may well have landed, but nothing here PROVES it, so it must not pass.
		return verdict(
			"unknown",
			`the remote-ref probe could not execute (${after.detail}) — the ref was neither confirmed nor refuted, so this is NOT a success; ${describeAttempt(attempt)}`,
			{where, observed: "probe-failed"},
		);
	}

	if (after.kind === "absent") {
		return verdict(
			"not-moved",
			`${ref} does not exist on ${remote} after the push — the branch was NOT landed; ${describeAttempt(attempt)}`,
			{where, observed: "absent"},
		);
	}

	if (after.sha !== expectedSha) {
		return verdict(
			"not-moved",
			`${ref} on ${remote} is at ${after.sha}, not the local head ${expectedSha} — the push did NOT land this commit; ${describeAttempt(attempt)}`,
			{where, observed: after.sha},
		);
	}

	if (!attemptIsClean(attempt)) {
		// The postcondition holds but the operation misbehaved: someone else may have put that
		// sha there, or git partially failed. Fail closed — report it, do not launder it into a
		// pass just because the ref happens to match.
		return verdict(
			"unknown",
			`${ref} on ${remote} IS at the local head ${expectedSha}, but ${describeAttempt(attempt)} — cannot attribute the landed ref to this push`,
			{where, observed: after.sha},
		);
	}

	return verdict(
		"moved",
		`${ref} on ${remote} confirmed at the local head ${expectedSha} by an independent ls-remote read`,
		{where, observed: after.sha},
	);
};
