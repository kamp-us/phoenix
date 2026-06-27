// drive-issue — the thin repo-local executor for the kampus pipeline (epic #1183).
//
// Dispatches the durable role agents by `agentType` and uses each stage's
// structured-JSON return as the sole control signal. It only ROUTES already-triaged
// work — it never re-triages, never edits, never merges. Control-plane PRs halt at
// reviewed-ready because the shipper itself refuses them (we do not re-encode that
// rule here). Saved workflows are not plugin-distributable, so this lives repo-local
// in `.claude/workflows/`, not in the kampus-pipeline plugin.

export const meta = {
	name: "drive-issue",
	description:
		"Drive one triaged issue through the kampus pipeline: epics route planner -> reviewer(review-plan); everything else runs coder -> reviewer -> repair(freeze-after-2) -> shipper, stopping at reviewed-ready when the shipper refuses a control-plane PR.",
	phases: ["Classify", "Plan", "Implement", "Review", "Repair", "Ship"],
};

// args carries the target issue number: accept `{ issue }` or a bare value.
const issue = Number(args && typeof args === "object" ? args.issue : args);
if (!Number.isInteger(issue) || issue <= 0) {
	throw new Error(
		`drive-issue: expected a positive issue number (args.issue or a bare number), got ${JSON.stringify(args)}`,
	);
}

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

// 3. Implement branch — coder -> reviewer -> repair(freeze-after-2) -> shipper.
phase("Implement");
log(`Implementing issue #${issue} with the coder agent`);
const built = await agent(
	`Implement issue #${issue}. You are the coder — load and follow the write-code skill: claim the issue, ` +
		`implement it on a branch, open a PR that closes it with \`Fixes #${issue}\`, leave a progress comment, ` +
		`and hand off to the parent epic. Do not review or merge your own work. ` +
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

let round = 0;
let verdict;
while (true) {
	phase("Review");
	log(`Reviewing PR #${pr} @ ${headSha} (round ${round})`);
	verdict = await agent(
		`Review PR #${pr}. You are the reviewer — classify the artifact and route to the matching review skill ` +
			`(review-code for source, review-doc for docs, review-skill for skills/agents), verify it against its ` +
			`linked issue's acceptance criteria one criterion at a time, and land a SHA-bound verdict comment on the PR. ` +
			`Return { verdict: "PASS"|"FAIL", sha: "<reviewed head sha>", classes: ["<the review class(es) you ran>"] }.`,
		{ agentType: "reviewer", isolation: "worktree", schema: reviewSchema },
	);
	log(`Review verdict for PR #${pr}: ${verdict.verdict} @ ${verdict.sha}`);

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
