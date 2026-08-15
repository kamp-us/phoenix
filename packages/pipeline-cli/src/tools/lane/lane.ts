/**
 * `lane` pure core — compute the active build-lane set from GitHub state, IO-free and total.
 *
 * The factory had no lane taxonomy: "how many lanes are running?" was answered by an engine
 * about itself, and a self-report mixed build lanes with review-plan gates and could not be
 * attributed to the engine that produced it (#3964, epic #3947). Everything below is derived
 * from artifacts a third party can re-read — open issues, their claim markers, open PRs — so
 * the count is verifiable WITHOUT asking the engine.
 *
 * Two facts about lanes drive the shape here, and both are why a single number lies:
 *
 *   1. A lane that has not LANDED is not the same as a coder that is RUNNING. An engine can
 *      hold five unlanded lanes with zero live coders. Nothing in GitHub observes a process,
 *      so this tool counts UNLANDED WORK and says so — never "active agents" — and it always
 *      breaks the total down by stage rather than emitting one ambiguous figure.
 *   2. A lane has two identities nothing links: `issue-<N>` and `pr-<M>` are free-form,
 *      independent resource keys (#3886, #4074), so one engine can hold the issue keys while a
 *      sibling holds the PR keys for the same work. The crew tracker that keyed them this way
 *      left with ADR 0279; the split identity did not, because the keys are still written per
 *      issue and per PR. The PR's own `Closes #N` link is the edge the keyspace lacks;
 *      `coalesce` below folds the pair into ONE lane and each lane publishes BOTH keys, so an
 *      external reconciliation can see which keys belong together.
 *
 * The `gh api` REST reads live in `github.ts`; the wiring in `command.ts`.
 */

/**
 * The founder-set lane budget (#3227): 6 concurrent build lanes, of which at most 2 may be
 * platform. Named here, once — the quota check (#3965) and the cycle heartbeat (#3948) read
 * these rather than re-declaring a number that then drifts from the ruling.
 */
export const LANE_CAPACITY = 6;
export const PLATFORM_QUOTA = 2;

/**
 * The platform discriminator, in exactly one place (#3964, resolved on epic #3947): a lane is
 * platform when its issue carries either existing label. Both already mean platform/infra work
 * — ADR 0208 made `axis:pipeline-hardening` a standing lane — so no new label or field is
 * introduced, and revising the predicate later is a one-constant change.
 */
export const PLATFORM_LABELS: ReadonlyArray<string> = ["area:infra", "axis:pipeline-hardening"];

/** One open issue, reduced to the facts lane occupancy and classification read. */
export interface LaneIssue {
	readonly number: number;
	readonly title: string;
	readonly labels: ReadonlyArray<string>;
	/**
	 * The session id of the earliest live authorized claim on the issue, or `null` when no
	 * claim stands. Resolved at the IO boundary by the shared ADR-0115 resolver (`resolveWinner`)
	 * — this core never re-derives claim ownership.
	 */
	readonly holder: string | null;
}

/** One open PR, reduced to the facts lane occupancy reads. */
export interface LanePr {
	readonly number: number;
	readonly title: string;
	/** Issues this PR closes, in body order — the link that folds a PR into its issue's lane. */
	readonly closes: ReadonlyArray<number>;
	readonly draft: boolean;
}

export interface LaneInventory {
	readonly issues: ReadonlyArray<LaneIssue>;
	readonly prs: ReadonlyArray<LanePr>;
}

/**
 * Where an unlanded lane sits. `claimed` = a claim holds the issue and no PR is open yet (a
 * coder may or may not be running — this stage does NOT assert a live process). `in-review` =
 * an open PR exists, so the lane is through building and waiting on review/approval/merge.
 */
export type LaneStage = "claimed" | "in-review";

/**
 * `indeterminate` is reachable only for a lane whose issue cannot be read (an open PR that
 * links no issue, or links one outside the scanned open set). It is kept distinct from
 * `product` on purpose: defaulting an unreadable lane to `product` would silently under-count
 * platform spend, which is the exact class of wrong number this tool exists to remove.
 */
export type LaneClass = "platform" | "product" | "indeterminate";

export interface Lane {
	/** The lane's stable id: its issue key when an issue is resolvable, else its PR key. */
	readonly key: string;
	readonly issue: number | null;
	readonly prs: ReadonlyArray<number>;
	readonly title: string;
	readonly stage: LaneStage;
	readonly classification: LaneClass;
	/** The claim session holding the issue, when one stands — the attribution a self-report cannot give. */
	readonly holder: string | null;
	/** Every tracker resource key this ONE lane occupies (#3886/#4074's unlinkable pair). */
	readonly trackerKeys: ReadonlyArray<string>;
}

export interface LaneCounts {
	/** Total lanes not yet landed — the number the capacity budget is spent against. */
	readonly unlanded: number;
	readonly claimed: number;
	readonly inReview: number;
	readonly platform: number;
	readonly product: number;
	readonly indeterminate: number;
}

export interface LaneReport {
	readonly capacity: number;
	readonly platformQuota: number;
	readonly scannedIssues: number;
	readonly scannedPrs: number;
	readonly lanes: ReadonlyArray<Lane>;
	readonly counts: LaneCounts;
}

/**
 * A scan that read nothing is not an idle factory — it is a broken read (bad token, wrong
 * repo, a `gh` fault), and reporting "0 lanes" for it is the vacuous green ADR 0092 makes
 * fail closed. Zero LANES from a non-empty scan is a legitimate clean answer, so the two are
 * separate states rather than the same zero.
 */
export type LaneStatus =
	| {readonly ok: false; readonly reason: "empty-scan"}
	| ({readonly ok: true} & LaneReport);

/**
 * GitHub's closing keywords, exactly (`docs.github.com/.../linking-a-pull-request-to-an-issue`).
 * Matching what GitHub itself acts on is what makes the coalescing edge real rather than a
 * convention this tool hopes PR bodies follow.
 */
const CLOSES_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;

/** The issue numbers a PR body closes, de-duplicated, in body order. */
export const parseCloses = (body: string): ReadonlyArray<number> => {
	const seen = new Set<number>();
	for (const match of body.matchAll(CLOSES_RE)) {
		const n = Number(match[1]);
		if (Number.isSafeInteger(n) && n > 0) seen.add(n);
	}
	return [...seen];
};

/** The one platform/product decision, applied to an issue's labels. */
export const classify = (labels: ReadonlyArray<string>): LaneClass =>
	labels.some((label) => PLATFORM_LABELS.includes(label)) ? "platform" : "product";

/**
 * THE LANE-OCCUPANCY PREDICATE, defined once (#3964).
 *
 * A lane is one unlanded unit of build work. It is occupied by
 *   (a) an open issue carrying a live authorized claim marker (ADR 0115), and/or
 *   (b) an open PR that has not merged — including a draft and a PR banked awaiting approval,
 *       both of which hold their lane until they land.
 * A PR whose body closes an issue belongs to THAT issue's lane; the pair is one lane, never
 * two. A PR that closes nothing readable is its own lane, keyed by its PR number.
 *
 * Deliberately NOT occupancy: a running coder process. Nothing in GitHub observes one, and
 * conflating the two is what produced the wrong lane number this tool replaces.
 */
export const coalesce = (inventory: LaneInventory): ReadonlyArray<Lane> => {
	const byNumber = new Map(inventory.issues.map((issue) => [issue.number, issue]));
	/** issue number → the open PRs folded into its lane, in PR order. */
	const prsByIssue = new Map<number, Array<LanePr>>();
	const prOnly: Array<LanePr> = [];

	for (const pr of inventory.prs) {
		// A PR closing several issues still holds ONE lane; keying on the first link keeps the
		// capacity arithmetic honest (spreading it across each linked issue would double-count).
		const anchor = pr.closes[0];
		if (anchor === undefined) {
			prOnly.push(pr);
			continue;
		}
		const existing = prsByIssue.get(anchor);
		if (existing === undefined) prsByIssue.set(anchor, [pr]);
		else existing.push(pr);
	}

	const lanes: Array<Lane> = [];
	const issueNumbers = new Set<number>([
		...inventory.issues.filter((issue) => issue.holder !== null).map((issue) => issue.number),
		...prsByIssue.keys(),
	]);
	for (const number of [...issueNumbers].sort((a, b) => a - b)) {
		const issue = byNumber.get(number);
		const prs = prsByIssue.get(number) ?? [];
		lanes.push({
			key: `issue-${number}`,
			issue: number,
			prs: prs.map((pr) => pr.number),
			title: issue?.title ?? prs[0]?.title ?? `#${number}`,
			stage: prs.length > 0 ? "in-review" : "claimed",
			classification: issue === undefined ? "indeterminate" : classify(issue.labels),
			holder: issue?.holder ?? null,
			trackerKeys: [`issue-${number}`, ...prs.map((pr) => `pr-${pr.number}`)],
		});
	}
	for (const pr of prOnly.sort((a, b) => a.number - b.number)) {
		lanes.push({
			key: `pr-${pr.number}`,
			issue: null,
			prs: [pr.number],
			title: pr.title,
			stage: "in-review",
			classification: "indeterminate",
			holder: null,
			trackerKeys: [`pr-${pr.number}`],
		});
	}
	return lanes;
};

const tally = (lanes: ReadonlyArray<Lane>): LaneCounts => ({
	unlanded: lanes.length,
	claimed: lanes.filter((lane) => lane.stage === "claimed").length,
	inReview: lanes.filter((lane) => lane.stage === "in-review").length,
	platform: lanes.filter((lane) => lane.classification === "platform").length,
	product: lanes.filter((lane) => lane.classification === "product").length,
	indeterminate: lanes.filter((lane) => lane.classification === "indeterminate").length,
});

/** Compute the lane status over a scanned inventory. */
export const status = (inventory: LaneInventory): LaneStatus => {
	if (inventory.issues.length === 0 && inventory.prs.length === 0) {
		return {ok: false, reason: "empty-scan"};
	}
	const lanes = coalesce(inventory);
	return {
		ok: true,
		capacity: LANE_CAPACITY,
		platformQuota: PLATFORM_QUOTA,
		scannedIssues: inventory.issues.length,
		scannedPrs: inventory.prs.length,
		lanes,
		counts: tally(lanes),
	};
};

const laneRow = (lane: Lane): string =>
	[
		`  ${lane.key.padEnd(14)}`,
		lane.stage.padEnd(10),
		lane.classification.padEnd(14),
		(lane.holder ?? "—").padEnd(38),
		lane.title.slice(0, 60),
	].join(" ");

/**
 * The human report. It names the two numbers separately on purpose — a lane is unlanded work,
 * a coder is a process, and no GitHub read can see the second. Stating that in the output is
 * what stops the next reader from repeating the conflation.
 */
export const renderReport = (result: LaneStatus): string => {
	if (!result.ok) {
		return (
			"lane: the scan read ZERO open issues and ZERO open PRs — fail-closed (ADR 0092). " +
			"An empty scan is indistinguishable from a broken read (missing token, wrong repo, `gh` " +
			"fault), and reporting it as an idle factory would be a vacuous zero. Check `gh auth status` " +
			"and the resolved repo."
		);
	}
	const {counts} = result;
	const head =
		`lane: ${counts.unlanded} of ${result.capacity} build lanes occupied ` +
		`(${counts.claimed} claimed, ${counts.inReview} in-review) — ` +
		`${counts.platform} platform of a quota of ${result.platformQuota}, ` +
		`${counts.product} product` +
		(counts.indeterminate > 0 ? `, ${counts.indeterminate} indeterminate` : "") +
		`. Scanned ${result.scannedIssues} open issue(s) and ${result.scannedPrs} open PR(s).`;
	const rows =
		result.lanes.length === 0
			? "  (no occupied lane)"
			: [
					`  ${"LANE".padEnd(14)} ${"STAGE".padEnd(10)} ${"CLASS".padEnd(14)} ${"HOLDER".padEnd(38)} TITLE`,
					...result.lanes.map(laneRow),
				].join("\n");
	return `${head}\n\n${rows}\n\n${FOOTNOTE}`;
};

const FOOTNOTE =
	"  A lane is UNLANDED WORK, not a running agent: a `claimed` lane may have no coder process\n" +
	"  alive, and an `in-review` lane holds its slot until the PR merges. Nothing in GitHub\n" +
	"  observes a process, so this count never claims to.\n" +
	"  Each lane lists BOTH tracker resource keys it occupies (issue-N and pr-M). They are keyed\n" +
	"  independently and nothing links them (#3886, #4074) — the PR's `Closes #N` is the edge\n" +
	"  that folds them into one lane here.";
