// drive-issue — the thin repo-local executor for the kampus pipeline (epic #1183).
//
// Dispatches the durable role agents by `agentType` and uses each stage's
// structured-JSON return as the sole control signal. It only ROUTES already-triaged
// work — it never re-triages, never edits, never merges. Control-plane PRs halt at
// reviewed-ready because the shipper itself refuses them (we do not re-encode that
// rule here). Saved workflows are not plugin-distributable, so this lives repo-local
// in `.claude/workflows/`, not in the kampus-pipeline plugin.
//
// Pre-spawn claim (ADR 0115 §3, orchestrated path): the Implement branch acquires the
// agent-distinguishable claim BEFORE the coder dispatch and spawns the coder only on a
// win, threading the winning claim token through so the coder treats it as its delegated
// own instead of re-racing. A lost claim aborts the dispatch and returns `{ skipped }`
// before any branch or build — closing the collision window the old in-coder self-assign
// (write-code Step 3, mid-run) left open.

export const meta = {
	name: "drive-issue",
	description:
		"Drive one triaged issue through the kampus pipeline: epics route planner -> reviewer(review-plan); everything else atomically claims the issue pre-spawn (ADR 0115) and only on a win runs coder -> reviewer -> repair(freeze-after-2) -> shipper, stopping at reviewed-ready when the shipper refuses a control-plane PR; a lost claim skips before any work starts.",
	phases: ["Classify", "Plan", "Implement", "Review", "Repair", "Ship"],
};

// args carries the target issue number: accept `{ issue }` or a bare value.
const issue = Number(args && typeof args === "object" ? args.issue : args);
if (!Number.isInteger(issue) || issue <= 0) {
	throw new Error(
		`drive-issue: expected a positive issue number (args.issue or a bare number), got ${JSON.stringify(args)}`,
	);
}

// Trivial-diff tier (ADR 0120 §2-§4). The right-sized fan-out routes a trivially-classified
// PR to the lighter `review-trivial` gate instead of the full `review-code`/`review-doc`/
// `review-skill` fan-out. ADOPTED default-ON per the #1562 measurement (both ADR 0112 axes
// cleared on a measured basis: −22%/−32% token-per-review vs the full gate — a conservative
// floor — AND the quality veto held, `review-trivial` catching a seeded off-by-one at
// `review-code` parity). Escape hatch: `KAMPUS_TRIVIAL_TIER=off` (or `args.trivialTier=false`)
// forces every PR back onto the full fan-out. This flip changes ONLY the tier's enable default;
// the fail-closed routing below is untouched — a classifier error or `non-trivial` verdict still
// falls to the full path, so a misclassification can still only over-pay, never under-gate.
const TRIVIAL_TIER_ENABLED =
	!(typeof process !== "undefined" && !!process.env && process.env.KAMPUS_TRIVIAL_TIER === "off") &&
	!(args && typeof args === "object" && args.trivialTier === false);

// Default-deny tier routing (ADR 0120 §3). The LIGHTER path is selected ONLY on the full
// positive conjunction — the tier is enabled AND the classifier ran OK AND its verdict is
// exactly `trivial`. Any other state — tier disabled, classifier error/unparseable, a
// `non-trivial` verdict, or an unrecognized verdict word — falls back to the FULL fan-out, so a
// misclassification can only ever over-pay the full (correct) cost, never under-gate. This
// mirrors the unit-tested canonical predicate `selectReviewTier` in
// packages/pipeline-cli/src/tools/trivial-diff/route.ts; it is inlined (not imported) because a
// workflow script — top-level return + injected globals — is not importable as a module.
function selectReviewTier(trivialTierEnabled, classifierOk, verdict) {
	return trivialTierEnabled && classifierOk && verdict === "trivial" ? "lighter" : "full";
}

// Disambiguating first line (#1768): `meta` is a pure literal (Workflow contract), so its
// static top-row label can't carry the target number — concurrent drive-issue rows would be
// indistinguishable. Emit the already-parsed `issue` as the workflow's VERY FIRST log line so
// the progress tree of each concurrent run is disambiguated by issue number from the top.
log(`drive-issue #${issue}`);

// 1. Classify — a lightweight READ of the already-triaged `type:` label to route.
// Deliberately NOT the triager agent: triager is needs-triage INTAKE and would
// mutate; the executor only reads the label to route it (epic -> planner).
phase("Classify");
log(`Classifying issue #${issue} by its type: label`);
const klass = await agent(
	`Read issue #${issue} on the pipeline target repo using \`gh api\` REST (never GraphQL): ` +
		`resolve the repo as \${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}, ` +
		`then \`gh api repos/$REPO/issues/${issue} --jq '[.labels[].name]'\`. ` +
		`Find the single \`type:*\` label. Do NOT modify the issue, add labels, or comment — this is a read-only classification. ` +
		`Return { isEpic: true|false, type: "<the type: label, e.g. type:epic / type:feature / type:chore>" }.`,
	{
		schema: {
			type: "object",
			properties: {
				isEpic: { type: "boolean" },
				type: { type: "string" },
			},
			required: ["isEpic", "type"],
			additionalProperties: false,
		},
	},
);
log(`Issue #${issue} classified as ${klass.type} (isEpic=${klass.isEpic})`);

// 2. Epic branch — plan the epic, then gate the plan with review-plan. No coder/shipper.
if (klass.isEpic) {
	phase("Plan");
	log(`Planning epic #${issue} with the planner agent`);
	const plan = await agent(
		`Plan epic #${issue} into an executable task ledger. You are the planner — load and follow the ` +
			`plan-epic skill, create the sub-issues with their \`## Dependencies\` topology, and acquire/release the ` +
			`planning lock. Leave the planned -> triaged flip to the review-plan gate. ` +
			`Return { planned: true|false, headOrIssue: "<the epic issue number or the plan head ref>" }.`,
		{
			agentType: "planner",
			schema: {
				type: "object",
				properties: {
					planned: { type: "boolean" },
					headOrIssue: { type: "string" },
				},
				required: ["planned", "headOrIssue"],
				additionalProperties: false,
			},
		},
	);
	log(`Planner returned planned=${plan.planned} (${plan.headOrIssue})`);

	phase("Review");
	log(`Gating the plan for epic #${issue} with review-plan`);
	const planVerdict = await agent(
		`Review the epic plan for #${issue}. You are the reviewer — route to review-plan: verify the planned ` +
			`ledger against the deterministic structural floor and land a SHA-bound verdict. ` +
			`Return { verdict: "PASS"|"FAIL", sha: "<reviewed sha or ref>" }.`,
		{
			agentType: "reviewer",
			isolation: "worktree",
			schema: {
				type: "object",
				properties: {
					verdict: { enum: ["PASS", "FAIL"] },
					sha: { type: "string" },
				},
				required: ["verdict", "sha"],
				additionalProperties: false,
			},
		},
	);
	log(`review-plan verdict: ${planVerdict.verdict} @ ${planVerdict.sha}`);

	// On PASS the children are pickable. No coder/shipper for epics.
	return { epic: true, planVerdict };
}

// 3. Implement branch — pre-spawn claim -> coder -> reviewer -> repair(freeze-after-2) -> shipper.
phase("Implement");

// 3a. Pre-spawn atomic claim (ADR 0115 §3, orchestrated path). Acquire the
// agent-distinguishable claim BEFORE the coder is spawned, closing the window in which a
// second orchestrator also picks #N while the old mid-run self-assign (write-code Step 3)
// was still pending. The claim agent is the orchestrator's hand — the workflow runtime can
// only `agent()`, so it delegates the §7/#1452 claim primitive to a thin claim-only agent
// and threads the winning token onward. It is the ONE contract's third surface, not a fourth
// hand-rolled copy. On a lost claim we abort the dispatch (no coder spawns) and return a
// structured `{ skipped }` outcome a caller can tell apart from a successful build.
log(`Acquiring the pre-spawn claim on issue #${issue} before dispatching the coder`);
const claim = await agent(
	`Acquire the kampus pipeline pre-spawn claim on issue #${issue} for the orchestrator, then STOP — ` +
		`do not branch, implement, or open a PR; this is the claim only. Follow ADR 0115 ` +
		`(.decisions/0115-agent-distinguishable-claim-marker.md) §1-§3 and the single §7 claim primitive in ` +
		`claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md verbatim — do NOT hand-roll a fourth copy. ` +
		`All GitHub ops via \`gh api\` REST, never GraphQL; resolve the repo as ` +
		`\${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}. Procedure: ` +
		`(1) read your own claim token TOKEN="$CLAUDE_CODE_SESSION_ID" — if it is empty, ABORT (fail-closed, ADR 0115 §"Trust + fail-closed") ` +
		`and return { won: false, token: "", reason: "no CLAUDE_CODE_SESSION_ID — cannot post an agent-distinguishable claim" }; ` +
		`(2) Rule-0 defer: read the issue's assignees and its existing claim comments — if an authorized claim ` +
		`(\`claim: <session> · <ts>\` from an account with write+ on the repo, ADR 0055 trust root) from a DIFFERENT session already owns it, ` +
		`back off WITHOUT posting and return { won: false, token: "", reason: "already claimed by another agent" }; ` +
		`(3) self-assign (the coarse availability gate) then post the claim comment \`claim: <TOKEN> · <ISO-8601-UTC>\` via ` +
		`\`gh api repos/$REPO/issues/${issue}/comments\`; (4) detect-and-tiebreak: the winner is the EARLIEST authorized claim ` +
		`(min created_at, then min comment id) — empty authorized set ⇒ no winner (fail-closed); recognize ownership by comparing that ` +
		`winning claim's embedded session id to your TOKEN; (5) if the winner is NOT you, RETRACT your own claim comment, self-unassign, ` +
		`and return { won: false, token: "", reason: "lost the claim tiebreak to an earlier authorized claim" }. ` +
		`On a confirmed win return { won: true, token: "<TOKEN>", reason: "" }.`,
	{
		schema: {
			type: "object",
			properties: {
				won: { type: "boolean" },
				token: { type: "string" },
				reason: { type: "string" },
			},
			required: ["won", "token"],
			additionalProperties: false,
		},
	},
);

if (!claim.won) {
	log(`Issue #${issue}: claim lost to a co-racer — skipping before any work starts (${claim.reason ?? "already claimed"})`);
	return { skipped: true, issue, reason: claim.reason ?? "already claimed by another agent" };
}
log(`Claim acquired on issue #${issue} (token ${claim.token}); dispatching the coder with the delegated claim`);

log(`Implementing issue #${issue} with the coder agent`);
const built = await agent(
	`Implement issue #${issue}. You are the coder — load and follow the write-code skill: implement it on a branch, ` +
		`open a PR that closes it with \`Fixes #${issue}\`, leave a progress comment, and hand off to the parent epic. ` +
		`Do not review or merge your own work. NOTE: the orchestrator has ALREADY claimed this issue pre-spawn per ` +
		`ADR 0115 §3 — your delegated claim token is "${claim.token}". The claim comment whose session id equals this token ` +
		`is YOURS; recognize it as your delegated claim and do NOT re-race or post a second claim (ADR 0115 §3 "Delegated ownership") ` +
		`— proceed straight to implementing. ` +
		`Return { pr: <PR number>, headSha: "<head commit sha of the PR>" }.`,
	{
		agentType: "coder",
		isolation: "worktree",
		schema: {
			type: "object",
			properties: {
				pr: { type: "number" },
				headSha: { type: "string" },
			},
			required: ["pr", "headSha"],
			additionalProperties: false,
		},
	},
);
const pr = built.pr;
let headSha = built.headSha;
log(`Coder opened PR #${pr} @ ${headSha}`);

// Review / Repair loop with freeze-after-2: at most 2 consecutive repair rounds.
const reviewSchema = {
	type: "object",
	properties: {
		verdict: { enum: ["PASS", "FAIL"] },
		sha: { type: "string" },
		classes: { type: "array", items: { type: "string" } },
	},
	required: ["verdict", "sha"],
	additionalProperties: false,
};
const repairSchema = {
	type: "object",
	properties: {
		pr: { type: "number" },
		headSha: { type: "string" },
	},
	required: ["headSha"],
	additionalProperties: false,
};
// The lighter gate may DECLINE (re-affirm fail-closed: the diff is not actually trivial), a
// plain note, not a verdict — the executor then re-routes it to the full path this round.
const trivialReviewSchema = {
	type: "object",
	properties: {
		verdict: { enum: ["PASS", "FAIL", "DECLINED"] },
		sha: { type: "string" },
		classes: { type: "array", items: { type: "string" } },
	},
	required: ["verdict", "sha"],
	additionalProperties: false,
};
// The tier-classifier probe (ADR 0120 §1). Consumes the trivial-diff classifier's stdout
// verdict via its CLI contract — never its internals — and is fail-closed: any failure to run
// or parse the classifier returns { classifierOk: false }, which the default-deny predicate
// routes to the full path.
const tierSchema = {
	type: "object",
	properties: {
		verdict: { type: "string" },
		classifierOk: { type: "boolean" },
	},
	required: ["verdict", "classifierOk"],
	additionalProperties: false,
};

// The full fan-out review (the unchanged default path). Extracted so both the default route
// and the lighter gate's fail-closed fallback dispatch the identical reviewer.
const runFullReview = () =>
	agent(
		`Review PR #${pr}. You are the reviewer — classify the FULL diff against every artifact class, then run the ` +
			`matching review gate for EVERY non-blocking class the diff spans, IN THIS ONE PASS (review-code for source, ` +
			`review-doc for docs, review-skill for skills/agents). A mixed code+docs (or code+skill, etc.) PR is NOT done ` +
			`when one namespace passes: routing means "run the gate for every present class," not "pick one and stop." ` +
			`Verify each present class against the linked issue's acceptance criteria one criterion at a time, and land a ` +
			`SHA-bound verdict comment on the PR in EVERY present namespace (a review-code AND a review-doc marker for a ` +
			`mixed code+docs PR), all bound to the same current head, so the PR reaches ship-it with a current-head PASS ` +
			`standing in each present namespace and never bounces back for a second review pass (#1460). Return ` +
			`verdict "PASS" ONLY when every present namespace's current-head verdict is PASS; "FAIL" if any present ` +
			`namespace failed. ` +
			`Return { verdict: "PASS"|"FAIL", sha: "<reviewed head sha>", classes: ["<every review class you ran, one per present namespace>"] }.`,
		{ agentType: "reviewer", isolation: "worktree", schema: reviewSchema },
	);

let round = 0;
let verdict;
while (true) {
	// Tier branch (ADR 0120 §2-§3): classify the PR diff and route the Review phase. Default-deny
	// / fail-closed — only an explicit `trivial` from an OK classifier while the tier is enabled
	// takes the lighter `review-trivial` gate; every other state (incl. the tier's off-by-default
	// state) takes the full fan-out. The classify probe runs only when the tier is enabled, so
	// off ⇒ zero added cost and behaviour identical to the pre-tier executor.
	let tier = "full";
	if (TRIVIAL_TIER_ENABLED) {
		phase("Classify");
		log(`Classifying PR #${pr} @ ${headSha} diff for the trivial tier (ADR 0120 §1)`);
		const cls = await agent(
			`Classify the diff of PR #${pr} on the pipeline target repo with the deterministic trivial-diff classifier — ` +
				`consume ONLY its stdout-verdict CLI contract (ADR 0120 §1), never its internals. All GitHub ops via ` +
				`\`gh api\` REST, never GraphQL; resolve the repo as ` +
				`\${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}. Procedure: fetch the PR's ` +
				`unified diff with \`gh api repos/$REPO/pulls/${pr} -H 'Accept: application/vnd.github.v3.diff'\`, then pipe it ` +
				`to \`node packages/pipeline-cli/src/bin.ts trivial-diff classify --repo "$REPO"\` (the diff on stdin). Read the ` +
				`single verdict WORD the CLI prints to STDOUT — \`trivial\` or \`non-trivial\`. This is a READ-ONLY probe: do NOT ` +
				`edit, comment, review, label, or merge anything. FAIL-CLOSED: if you cannot fetch the diff, run the CLI, or parse ` +
				`a clean \`trivial\`/\`non-trivial\` word from stdout for ANY reason, return { verdict: "non-trivial", classifierOk: false }. ` +
				`On a clean run return { verdict: "<the stdout word>", classifierOk: true }.`,
			{ schema: tierSchema },
		);
		tier = selectReviewTier(true, cls.classifierOk === true, cls.verdict);
		log(`Tier for PR #${pr}: ${tier} (classifier verdict=${cls.verdict}, ok=${cls.classifierOk})`);
	}

	phase("Review");
	log(`Reviewing PR #${pr} @ ${headSha} (round ${round}, ${tier} gate)`);
	if (tier === "lighter") {
		verdict = await agent(
			`Review PR #${pr}. You are the reviewer — route to the LIGHTER gate: load and follow the review-trivial skill ` +
				`(ADR 0120 §2). A deterministic classifier already established this diff is trivial; re-affirm that fail-closed ` +
				`under your own eyes, run the tight scoped checklist over the small diff, and land a SHA-bound PASS/FAIL verdict ` +
				`in the EXISTING review-code/review-doc/review-skill namespace for the diff's artifact class (never a new ` +
				`marker). If the diff is NOT actually trivial (control-plane present, boundary unreadable, not small/single-concern, ` +
				`or a new surface), DECLINE per review-trivial Step 0 — emit the plain not-trivial note, post NO verdict marker, and ` +
				`return verdict "DECLINED" so the executor re-routes to the full path. ` +
				`Return { verdict: "PASS"|"FAIL"|"DECLINED", sha: "<reviewed head sha>", classes: ["<the one namespace you gated, or empty on DECLINED>"] }.`,
			{ agentType: "reviewer", isolation: "worktree", schema: trivialReviewSchema },
		);
		if (verdict.verdict === "DECLINED") {
			log(`review-trivial declined PR #${pr} (not actually trivial) — falling back to the full fan-out (ADR 0120 §3)`);
			tier = "full";
			verdict = await runFullReview();
		}
	} else {
		verdict = await runFullReview();
	}
	log(`Review verdict for PR #${pr}: ${verdict.verdict} @ ${verdict.sha} (${tier} gate)`);

	if (verdict.verdict === "PASS") break;
	if (round >= 2) break; // freeze-after-2: stop after 2 repair attempts.
	round++;

	phase("Repair");
	log(`Repairing PR #${pr} per the latest FAIL verdict (repair round ${round})`);
	const repaired = await agent(
		`Repair PR #${pr}. You are the coder in REPAIR mode — consume the gate's latest FAIL verdict on PR #${pr}, ` +
			`fix the issues on the existing branch, and re-push so the stateless gate re-runs. Do not write a PASS and ` +
			`do not merge. ` +
			`Return { pr: ${pr}, headSha: "<new head commit sha after the repair push>" }.`,
		{ agentType: "coder", isolation: "worktree", schema: repairSchema },
	);
	headSha = repaired.headSha;
	log(`Repair round ${round} pushed PR #${pr} @ ${headSha}`);
}

// Still FAIL after the loop -> freeze for a human.
if (verdict.verdict !== "PASS") {
	log(`PR #${pr} frozen after ${round} repair round(s) (freeze-after-2)`);
	return { frozen: true, pr, rounds: round, reason: "freeze-after-2" };
}

// 4. Ship — the shipper runs its own Step 0 control-plane classify and REFUSES
// control-plane PRs (returning a blocked / reviewed-ready outcome). We do NOT
// re-encode the §CP regex here; a refusal IS the stop-at-reviewed-ready outcome.
phase("Ship");
log(`Shipping PR #${pr} (the shipper refuses control-plane PRs on its own)`);
const shipped = await agent(
	`Ship PR #${pr}. You are the shipper — run your Step 0 control-plane classify first. If PR #${pr} is ` +
		`control-plane (\`.claude/**\`, \`.github/**\`, or a gate-critical skill), REFUSE to merge and leave it ` +
		`reviewed-ready for a human hand-merge. Otherwise assert the matching gate PASS, confirm CI is green, ` +
		`squash-merge, and confirm the linked issue auto-closed. ` +
		`Return { merged: true|false, sha: "<merge commit sha if merged>", reviewedReady: true|false, reason: "<refusal reason if not merged>" }.`,
	{
		agentType: "shipper",
		isolation: "worktree",
		schema: {
			type: "object",
			properties: {
				merged: { type: "boolean" },
				sha: { type: "string" },
				reviewedReady: { type: "boolean" },
				reason: { type: "string" },
			},
			required: ["merged"],
			additionalProperties: false,
		},
	},
);
log(
	shipped.merged
		? `PR #${pr} merged${shipped.sha ? ` @ ${shipped.sha}` : ""}`
		: `PR #${pr} not merged (reviewedReady=${shipped.reviewedReady ?? false}): ${shipped.reason ?? "see shipper output"}`,
);

return {
	merged: !!shipped.merged,
	pr,
	rounds: round,
	sha: shipped.sha,
	reviewedReady: shipped.reviewedReady,
	reason: shipped.reason,
};
