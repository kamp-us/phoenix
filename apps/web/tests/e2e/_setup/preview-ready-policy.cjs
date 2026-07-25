// Pure policy core of the e2e preview-readiness gate (`preview-ready.cjs`).
//
// Split out so the two things that gate can get silently wrong — its budget
// arithmetic and its failure attribution — are unit-testable offline: nothing
// here launches a browser, opens a socket, or reads a clock. `.cjs` because the
// gate that consumes it is a Playwright `globalSetup` in CommonJS (ADR 0001).
//
// The attribution half exists because a `globalSetup` throw is reported against
// whichever spec Playwright names first, so the gate's own output is the ONLY
// thing that can say "the preview was not warm" rather than "the sözlük
// create-flow is broken" — and when it couldn't, an investigation went after the
// wrong subsystem for a week (#3179).

const PROBE_KIND = {
	spaRoute: "spa-route",
	authRead: "auth-read",
	authWrite: "auth-write",
};

/** A readiness probe, named so a failure says which one. */
function describeProbe(probe) {
	return `${probe.kind} ${probe.target}`;
}

// The poll interval rate-limits how often an ATTEMPT MAY START — it is not dead
// time to append after every failure. A probe that fails by timing out has
// already backed off for its whole timeout (10s ≫ the 3s interval), so sleeping
// again spends budget buying nothing: on the live cold boot of PR #3176 the gate
// burned 9s of its 90s cap on three such sleeps. A probe that fails FAST (an
// auth route answering 404 immediately) is the case the interval is actually for,
// and still gets the full remainder. See #3179.
function sleepAfterAttemptMs({attemptElapsedMs, pollIntervalMs, remainingMs}) {
	const owed = Math.max(0, pollIntervalMs - attemptElapsedMs);
	return Math.max(0, Math.min(owed, remainingMs));
}

// The per-probe timeout, clamped to what is left of the hard cap. Unclamped, the
// cap was not a cap: the deadline was only tested between attempts, so an attempt
// whose probes each ran their full timeout could overrun it by a whole attempt
// (5 routes x (goto 10s + topbar 10s) + 2 auth probes ~ 100s on top of the
// documented 90s). `null` means the budget is spent — the caller must stop
// rather than start a probe it has no time for.
function probeTimeoutMs({remainingMs, attemptTimeoutMs}) {
	if (remainingMs <= 0) return null;
	return Math.min(attemptTimeoutMs, remainingMs);
}

// The gate's failure is a preview-infrastructure verdict, so it carries the
// attribution a naked `Error` could not: which probe was outstanding, how many
// attempts it got, how long it actually waited — and, load-bearing, that the
// spec name Playwright prints beside it means nothing (#3179).
class PreviewNotWarmError extends Error {
	constructor({baseURL, budgetMs, elapsedMs, attempts, probe, lastError}) {
		super(
			`[preview-ready] PREVIEW READINESS GATE FAILED — ${baseURL} never became warm ` +
				`within ${budgetMs}ms (${attempts} attempt(s), ${elapsedMs}ms elapsed).\n` +
				`  Outstanding probe: ${probe ? describeProbe(probe) : "(no attempt completed)"}\n` +
				`  Last failure: ${lastError}\n` +
				"  This is the Playwright globalSetup preview-readiness gate, NOT a spec failure. " +
				"Playwright attributes a globalSetup throw to whichever spec it reports first, so any " +
				"spec name shown next to this error is arbitrary — investigate the per-PR preview " +
				"deploy, not that spec, and not this PR's diff (#3179).",
		);
		this.name = "PreviewNotWarmError";
		this.baseURL = baseURL;
		this.budgetMs = budgetMs;
		this.elapsedMs = elapsedMs;
		this.attempts = attempts;
		this.probe = probe;
		this.lastError = lastError;
	}
}

function formatAttemptFailure({attempt, probe, probeElapsedMs, remainingMs, sleepMs, lastError}) {
	return (
		`[preview-ready] attempt ${attempt}: ${describeProbe(probe)} not ready after ${probeElapsedMs}ms ` +
		`(${remainingMs}ms of budget left) — ${lastError} — retrying in ${sleepMs}ms…`
	);
}

// Says the gate PASSED, in as many words. The #3179 misdiagnosis read this run's
// "not ready yet" retry lines as the cause of a red that happened AFTER this
// line — so the success line has to close that reading itself.
function formatWarm({baseURL, attempts, elapsedMs, probeCount}) {
	return (
		`[preview-ready] preview warm at ${baseURL} after ${attempts} attempt(s) / ${elapsedMs}ms ` +
		`(${probeCount} probes passed) — THE READINESS GATE PASSED. Any failure later in this run is ` +
		"a real spec failure, not preview warmth (#3179)."
	);
}

module.exports = {
	PROBE_KIND,
	PreviewNotWarmError,
	describeProbe,
	formatAttemptFailure,
	formatWarm,
	probeTimeoutMs,
	sleepAfterAttemptMs,
};
