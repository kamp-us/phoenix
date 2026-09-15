/**
 * `lane recover` — find every lane whose own artifact already proves the event its ledger is
 * missing, and record it.
 *
 * A reviewer posts its SHA-bound verdict on the PR and then runs `lane report`. A shell killed
 * between the two leaves the verdict standing and the ledger silent, and nothing downstream can see
 * it: one lane sat in `review` for 448 minutes carrying a head-bound `review-code: PASS` the whole
 * time, and its recovery — `lane prove <lane> PASS`, then `lane transition <lane> PASS` — was two
 * commands and no judgement. This is that recovery as a sweep. Every provider-killed reviewer or
 * shipper lands in the same state, so the cost scales with how often shells die rather than with how
 * hard lanes are.
 *
 * **Where it lives is a decision, not an accident.** The symptom is already detected in the
 * `heal-ci` group, whose scheduled sweep saw that same stranded PR and routed it to `ship` on the PR
 * itself while the ledger stayed three events short — but that group's own law is that it summons
 * nobody and writes no ledger (`heal-ci/SKILL.md` §2, anchor `NEVER-DISPATCH`), and its lane arm is a
 * total lookup from a stall class to a lane token. An arm there that appended would need that law
 * amended. So the write lives in the `lane` group beside the other cross-lane sweeps, where appending
 * to a ledger is already what the group does: `lane stale` derives silence against a shell budget and
 * reads no artifact, `lane reconcile` reads an artifact and corrects an already-recorded line, and
 * this reads an artifact and records a line nobody wrote.
 *
 * **It adds no trust and no proof path.** The claim's bar is `lane prove`'s, unchanged, and the
 * append is `lane transition`'s, unchanged — the same machine validation, the same proof gate and the
 * same ledger lock a driver's own record goes through. What moves is only who runs them: a sweep
 * rather than a person who happened to think of it.
 *
 * **It records on the literal `proven` and on nothing else.** `not-required` and every refusal code
 * leave the lane exactly where it was and land as their own row, so an unreadable board is a row to
 * re-run rather than a lane moved on a read nobody made.
 *
 * **And it asks only about the events a finished shell alone can have earned.** A `PASS` out of
 * either review cell is the whole owed set; the `BLOCKED` a reviewer's park claims and the `DONE` a
 * builder's open PR claims are both out of scope, because a shell that is merely still working
 * satisfies each of them too. `./recover.ts` carries the argument for both arms.
 *
 * **`--spawns` adds the second arm: the builder that died leaving nothing behind at all.** The arm
 * above recovers a shell that finished and could not say so; this one parks a lane whose shell never
 * finished and never will. Lane 7778 read `issue: build` for five days holding a seat against the
 * concurrency cap, because the only thing that records `BLOCKED --cause spawn-dead` was a driver
 * re-reading the lane by hand. **The conjunction it reads, and what each answer short of it means,
 * is written once in this verb's own reference row** (`../../docs/verb-reference.md`, `lane
 * recover`); repeating it here is what left five copies disagreeing about the population on the day
 * they landed.
 *
 * What this module owes beyond that row is the two invariants the code has to hold and the row
 * cannot show:
 *
 * - **Every conjunct is a read actually made, and every row's reason names the read it stands on.**
 *   The population spans two build leaves and three lane roles, so the third conjunct is picked off
 *   `./recover.ts`'s {@link publicationOf} rather than off the recorded-event claim table — see that
 *   function for what borrowing the other table cost.
 * - **It retracts nothing, and it is not the end of the chain.** Ending a claim stays the
 *   `spawn-dead` unpark row's act, on the same budget proof through the same `../build/dead-claim.ts`
 *   read — and that row is keyed on exactly the park this arm writes, so the claim does end, one
 *   verb later, with no person in between. The reference row names the decision record that admits
 *   a verb-made age read licensing that park.
 *
 * It is off unless a caller hands in the reads, because it costs board reads per building lane and
 * because recording a **park** is a different act from recording the verdict a finished shell earned.
 *
 * **A `recovered` row reports where the append says the lane landed, not where this sweep predicted
 * it would.** The prediction is taken off a fold nothing holds a lock over, and `lane transition`
 * re-reads and re-folds the log inside the ledger lock before it applies anything, so a writer
 * landing between the two makes them disagree — and the row a driver reads and acts on would name a
 * state the lane is not in, on an exit-0 sweep. A `--check` row keeps the prediction, which is the
 * only ground a run that appends nothing has.
 *
 * Each recoverable lane costs two board reads rather than one: this sweep asks the proof what the
 * answer is, and `lane transition` asks it again under its own gate before it appends. That second
 * read is the gate refusing to take this sweep's word for it, which is the property worth the read —
 * and it is paid only by a lane that is actually recoverable, which is a killed shell's lane and not
 * a busy one. `--check` pays the first read alone and appends nothing.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import type {ClaimStanding} from "../build/dead-claim.ts";
import type {ParkCauseSurface} from "../config/keys/park-cause.ts";
import type {Read} from "../config/read-key.ts";
import {exists, readDir} from "../io/fs.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {ANSWER, answer, refuse, type VerbOutcome} from "../verb.ts";
import {APPEND_UNKNOWN, CONCURRENT_WRITE, LANE_UNREADABLE} from "./codes.ts";
import {applyEvent, deriveStatus, foldLog, standingCauses} from "./fold.ts";
import {CHORE_PREFIX} from "./key.ts";
import type {PullTrace} from "./prove.ts";
import {epicOf, issueOf, roleOf} from "./prove.ts";
import type {ProofOutcome, ProveOptions} from "./prove-verb.ts";
import {buildingBy, DEAD_SPAWN_CAUSE, DEAD_SPAWN_EVENT, owedBy, publicationOf} from "./recover.ts";
import {DEFAULT_CHORES_ROOT, loadLane} from "./store.ts";
import {runTransition} from "./transition-verb.ts";

const VERB = "fabrika lane recover";

/** Which local branches were cut for an issue in this clone, or why that could not be read. */
export type BranchRead =
	| {readonly _tag: "Read"; readonly branches: ReadonlyArray<string>}
	| {readonly _tag: "Unknown"; readonly reason: string};

/** Which pull requests on the board link an issue, or why that could not be read. */
export type PullsRead =
	| {readonly _tag: "Read"; readonly trace: PullTrace; readonly scanned: number}
	| {readonly _tag: "Unknown"; readonly reason: string};

/**
 * The live reads the spawn arm turns on — handed in together, so the arm cannot be enabled without
 * them.
 *
 * All three are parameters rather than imports for the reason `prove` is: this verb's unit tier stays
 * offline, and the arm's whole behaviour is exercised against scripted answers. `claim` closes over
 * the instant and the budget it measures against, so nothing here reads a clock.
 */
export interface SpawnReads<R = never> {
	/** Whether the build claim on an issue has outlived the builder's budget — read, never retracted. */
	readonly claim: (issue: number) => Effect.Effect<ClaimStanding, never, R>;
	/** The lane branches this clone carries for an issue. */
	readonly branches: (issue: number) => Effect.Effect<BranchRead, never, R>;
	/**
	 * The open pull requests linking an issue — the arm's own read, not `prove`'s.
	 *
	 * Separate because the two answer different questions. `prove`'s `DONE` arm says what a *recorded
	 * event* asserts and keys on the plain `build` leaf, so a `build:ui` lane came back `not-required`
	 * at exit 0 and a child came back off a range read — and the arm reported both as a PR read that
	 * did not settle, over lanes that could then never be parked. `./recover.ts`'s `publicationOf`
	 * picks which surface to read per role, and this is the one it names for a lane that publishes to
	 * the board.
	 */
	readonly pulls: (issue: number) => Effect.Effect<PullsRead, never, R>;
}

export interface RecoverOptions<R = never> {
	readonly roots: ReadonlyArray<string>;
	/** Judge every lane and report what would be appended, appending nothing. */
	readonly check: boolean;
	/**
	 * The spawn arm's reads, or `null` for a sweep that asks only about the events an artifact proves.
	 *
	 * `null` rather than a boolean beside optional readers: the arm costs board reads per building
	 * lane and records a **park**, which is a different act from recording the verdict a finished
	 * shell earned, so a caller opts into it — and opting in without the reads is unwritable.
	 */
	readonly spawns: SpawnReads<R> | null;
	/**
	 * The proof, as a parameter rather than an import, so this verb's unit tier stays offline — the
	 * shape `lane transition` established, and this hands the very same prover on to it.
	 */
	readonly prove: (options: ProveOptions) => Effect.Effect<ProofOutcome, never, R>;
	/**
	 * The repo's `parkCause`, passed through to the append untouched.
	 *
	 * Inert here by construction — this sweep records a `PASS` and never a park — but it
	 * rides along so the append is byte-for-byte the path a driver's own `lane transition` takes,
	 * rather than a second path that happens to agree today.
	 */
	readonly parkCause: Read<ParkCauseSurface>;
	readonly repo: string | null;
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in, not the ledger root. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

type Verdict =
	| "recovered"
	| "recoverable"
	| "parked"
	| "parkable"
	| "working"
	| "unproven"
	| "contended"
	| "refused"
	| "current"
	| "terminal"
	| "unreadable"
	| "unappended";

const VERDICTS: ReadonlyArray<Verdict> = [
	"recovered",
	"recoverable",
	"parked",
	"parkable",
	"working",
	"unproven",
	"contended",
	"refused",
	"current",
	"terminal",
	"unreadable",
	"unappended",
];

/** The two verdicts an append landed, and the two a `--check` withheld — one pairing, read twice. */
const APPENDED: ReadonlyArray<Verdict> = ["recovered", "parked"];
const WITHHELD: ReadonlyArray<Verdict> = ["recoverable", "parkable"];

interface LaneRow {
	readonly key: string;
	readonly root: string;
	readonly verdict: Verdict;
	/** The task judged, and the leaf it stands in; absent where no task was reached. */
	readonly task?: string;
	readonly state?: string;
	/** The event that leaf owes; absent where the leaf owes none. */
	readonly event?: string;
	/** The park cause the event carries — the spawn arm's rows alone, which are the only parks here. */
	readonly cause?: string;
	/**
	 * Which of `lane prove`'s answers came back, and at which exit — `proof` is `null` on a refusal,
	 * where the code carries the whole answer, and the two together are what tells a `not-required`
	 * from an unreadable board without re-reading anything.
	 */
	readonly proof?: string | null;
	readonly proofCode?: number;
	/**
	 * What the lane folds to now, and where the event lands it.
	 *
	 * On a `recovered` row `to` is the append's **own** answer — `lane transition` derives it under
	 * the ledger lock from a fresh re-read of the log, so it accounts for every writer that landed
	 * between this sweep's unlocked fold and that lock. Every other row's `to` is the offline
	 * preview, which is all a move that never happened has: `recoverable` is a `--check` prediction,
	 * and a `refused` or `contended` row names the landing its event would have had.
	 */
	readonly from?: string;
	readonly to?: string;
	readonly reason?: string;
}

const keyOf = (root: string, name: string): string =>
	root.endsWith(DEFAULT_CHORES_ROOT) ? `${CHORE_PREFIX}${name}` : name;

const printable = (
	value: string | Readonly<Record<string, Readonly<Record<string, string>> | string>>,
): string => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * Where `lane transition`'s answer says the lane landed, printed as a row reads it.
 *
 * `null` where that answer carries no readable `current` — the one case a recovered row has to fall
 * back on its preview, and it says so on the row rather than presenting a prediction as the fact.
 */
const landedBy = (stdout: string): string | null => {
	const parsed = parseJson(stdout);
	if (!isRecord(parsed)) return null;
	const current = parsed.current;
	if (typeof current === "string") return current;
	if (isRecord(current)) return JSON.stringify(current);
	return null;
};

const recoverLane = <R>(
	root: string,
	name: string,
	options: RecoverOptions<R>,
): Effect.Effect<ReadonlyArray<LaneRow>, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const key = keyOf(root, name);
		const unreadable = (reason: string): ReadonlyArray<LaneRow> => [
			{key, root, verdict: "unreadable", reason},
		];
		const loaded = yield* loadLane({root, lane: name});
		// An entry with no workflow.json is not a lane, and reporting a scratch directory as one would
		// put noise in front of every real row.
		if (loaded._tag === "Absent") return [];
		if (loaded._tag === "Unreadable")
			return unreadable(`cannot read ${loaded.path}: ${loaded.reason}`);
		if (loaded._tag === "Malformed") {
			return unreadable(`${loaded.path} is not the shape: ${loaded.defects.join("; ")}`);
		}
		const folded = foldLog(loaded.lane, loaded.entries);
		if (folded._tag !== "Folded") {
			return unreadable(`${loaded.logPath} does not replay: ${folded.defects.join("; ")}`);
		}

		// The states every later row is judged against. A lane with two recoverable regions folds twice
		// in one sweep, so this walks forward with the appends rather than standing at the pre-sweep
		// fold — a `from` taken once would have the second row leaving a state the first row left.
		let states = folded.states;
		const status = deriveStatus(loaded.lane, states, standingCauses(loaded.entries));
		if (status.status === "done") {
			return [{key, root, verdict: "terminal" as const, from: printable(status.stateValue)}];
		}
		const owed = owedBy(status);
		const spawns = options.spawns;
		const building = spawns === null ? [] : buildingBy(status);
		if (owed.length === 0 && building.length === 0) {
			return [{key, root, verdict: "current" as const, from: printable(status.stateValue)}];
		}

		// Where this run has proven the lane stands, as a printed stateValue. It advances off the
		// append's own answer once one has landed, so a second region's `from` is the state the first
		// region's append actually left rather than the one this sweep predicted for it.
		let from = printable(status.stateValue);

		const rows: LaneRow[] = [];

		/**
		 * Preview the event offline, append it unless `--check` withheld the append, and push the row.
		 *
		 * The one tail both arms take, so the spawn arm is not a second way onto a lane's log: the
		 * preview is `applyEvent`'s and the append is `lane transition`'s whole path — machine
		 * validation, proof gate and ledger lock included. An arm supplies the event, the park cause it
		 * carries, and the two verdict names its landed and its withheld row read under.
		 */
		const record = (
			base: Omit<LaneRow, "verdict"> & {readonly task: string},
			event: string,
			cause: string | null,
			appended: Verdict,
			withheld: Verdict,
			partial: boolean | null,
			diagnosis: boolean | null,
		): Effect.Effect<void, never, R | FileSystem.FileSystem | Path.Path> =>
			Effect.gen(function* () {
				// The preview is taken offline off the same applier the append runs. It is a prediction
				// either way: the append re-folds the live log under the lock, so a writer landing in
				// between makes the two disagree, and a landed row below takes the append's answer.
				const applied = applyEvent(
					loaded.lane,
					states,
					base.task,
					event,
					new Date(0).toISOString(),
					null,
					null,
					partial,
					diagnosis,
					cause,
				);
				if (applied._tag === "Refused") {
					rows.push({
						...base,
						verdict: "refused",
						reason: `the ${event} is earned here, and this lane's own machine refuses it: ${applied.reason}`,
					});
					return;
				}
				const predicted = printable(applied.current.stateValue);
				// The states this event lands on become the next region's ground. `--check` advances too:
				// it is predicting the run that appends both rows, so a preview standing still would be a
				// preview of a run nobody can make. `landing` is what the next row reports leaving, and it
				// is the append's answer wherever there is one; `states` stays the offline applier's own,
				// which is the only machine-state record either mode has — a next region predicted off it
				// is corrected by that region's own append answer, and validated again under the lock.
				const advance = (landing: string) => {
					states = applied.states;
					from = landing;
				};
				if (options.check) {
					rows.push({...base, verdict: withheld, to: predicted});
					advance(predicted);
					return;
				}

				// The append is `lane transition`'s whole path — its machine validation, its proof gate and
				// its ledger lock — so nothing here is a second way onto a lane's log.
				const recorded = yield* runTransition(
					{
						root,
						lane: name,
						event,
						task: base.task,
						cause,
						parkCause: options.parkCause,
						classes: [],
						waitGrant: null,
						rationale: null,
						repo: options.repo,
						cwd: options.cwd,
						env: options.env,
					},
					options.prove,
				);
				if (recorded.code === ANSWER) {
					// The append answered where the lane landed, and that answer is the fact: it comes off
					// the fresh fold `lane transition` takes inside the ledger lock, so it accounts for any
					// writer that landed after this sweep's own unlocked fold. Reporting `predicted` here
					// would name a state the lane is not in, on an exit-0 sweep whose whole output is the
					// picture a driver acts on — and on a multi-region lane the divergence would ride into
					// every later row.
					const landing = landedBy(recorded.stdout);
					rows.push({
						...base,
						verdict: appended,
						to: landing ?? predicted,
						...(landing === null
							? {
									reason: `the append landed and its answer carried no readable state, so this row's ${predicted} is where this sweep's own fold predicted the lane lands, not where the append says it did — read the lane's fold for the fact`,
								}
							: {}),
					});
					advance(landing ?? predicted);
					return;
				}
				const why = recorded.stderr[recorded.stderr.length - 1] ?? "no reason given";
				// A lost lock is not a settled no. `refused` says this lane's own machine or config turned
				// the event down, so a re-run buys nothing; `CONCURRENT_WRITE` says another writer held the
				// lock for the whole wait budget, so nothing was validated and this same event is still the
				// right one. Bucketed together, a lane that only lost a race read as decided on an exit-0
				// sweep and nothing ever retried it.
				const verdict: Verdict =
					recorded.code === APPEND_UNKNOWN
						? "unappended"
						: recorded.code === CONCURRENT_WRITE
							? "contended"
							: "refused";
				rows.push({
					...base,
					verdict,
					to: predicted,
					reason:
						verdict === "contended"
							? `another writer held this lane's lock for the whole wait budget, so the ${event} was neither validated nor appended and this lane is still missing it — re-run the sweep: ${why}`
							: `the append refused at ${recorded.code}: ${why}`,
				});
			});

		for (const {task, leaf, event} of owed) {
			const base = {key, root, task, state: leaf, event, from};
			const proveOptions: ProveOptions = {
				root,
				lane: name,
				event,
				task,
				// The standing classes are the fold's own and this sweep relays none of its own: it is
				// recording the event a dead shell owed, not classifying the lane afresh.
				classes: null,
				// A sweep's record names no PR, exactly as a driver's `lane transition` names none.
				pr: null,
				repo: options.repo,
				cwd: options.cwd,
				env: options.env,
			};
			const proof = yield* options.prove(proveOptions);
			if (proof.code !== ANSWER || proof.proof !== "proven") {
				rows.push({
					...base,
					verdict: "unproven",
					proof: proof.proof,
					proofCode: proof.code,
					reason:
						proof.code === ANSWER
							? `the proof answered "${proof.proof ?? "an answer this reader does not recognise"}" rather than "proven", so there is nothing here the artifact already earned`
							: `the proof refused at ${proof.code}: ${proof.stderr[proof.stderr.length - 1] ?? "no reason given"}`,
				});
				continue;
			}

			yield* record(
				{...base, proof: proof.proof, proofCode: proof.code},
				event,
				null,
				"recovered",
				"recoverable",
				proof.partial,
				proof.diagnosis ? true : null,
			);
		}

		// The lane's whole task set, so a child region is told from a single lane's one task by the
		// emitter's own naming rather than by which tasks happen to be active this sweep.
		const epic = epicOf(Object.keys(loaded.lane.tasks));

		for (const {task, leaf} of building) {
			// `building` is empty unless the arm was handed its reads, so this narrowing can never be
			// the thing that decides whether the arm runs.
			if (spawns === null) break;
			// No `event` on the base: a lane whose builder is alive and well is a `working` row, and a
			// row carrying `event: "BLOCKED"` would tell a driver reading stdout that a park is what this
			// sweep judged it owed. The event rides the two rows that actually record one.
			const base = {key, root, task, state: leaf, from};
			const hold = (verdict: Verdict, reason: string): void => {
				rows.push({...base, verdict, reason});
			};
			const issue = issueOf(task, key);
			if (issue === null) {
				hold(
					"unreadable",
					`neither task "${task}" nor lane "${key}" names an issue number, so the builder's residue cannot be read`,
				);
				continue;
			}

			// The claim read first, because it is the one fact that decides most building lanes and the
			// one the ADR ban turns on: everything else this arm reads is about residue, and residue
			// under a live claim is a shell still working.
			const claim = yield* spawns.claim(issue);
			if (claim._tag === "Unknown") {
				hold(
					"unreadable",
					`whether a build claim stands on #${issue} could not be read: ${claim.reason} — never read as dead`,
				);
				continue;
			}
			if (claim._tag === "Unclaimed") {
				hold(
					"working",
					`no build claim stands on #${issue}, so nothing here is a dead shell's residue — a lane in ${leaf} with no claim is a dispatch \`lane stale\` reports, not a park`,
				);
				continue;
			}
			if (claim._tag === "Alive") {
				hold(
					"working",
					`${claim.token} has claimed #${issue} for ${claim.ageMinutes} of its ${claim.budgetMinutes} minute(s), so its shell may still be working`,
				);
				continue;
			}

			const branches = yield* spawns.branches(issue);
			if (branches._tag === "Unknown") {
				hold(
					"unreadable",
					`whether this clone carries a lane branch for #${issue} could not be read: ${branches.reason} — never read as dead`,
				);
				continue;
			}
			if (branches.branches.length > 0) {
				hold(
					"working",
					`${claim.token}'s claim on #${issue} is past its ${claim.budgetMinutes}-minute budget and ${branches.branches.join(", ")} still carries its commits — what to do with a dead builder's work is a salvage nobody has decided, so this arm leaves it`,
				);
				continue;
			}

			// The last conjunct: did this builder get far enough to leave its work somewhere? Which
			// surface that is turns on the lane's role, not on its leaf — `publicationOf` carries why,
			// and why this is not the recorded-event claim table's question.
			const publication = publicationOf(roleOf(task, epic));
			const park = (why: string) =>
				record(
					{
						...base,
						event: DEAD_SPAWN_EVENT,
						cause: DEAD_SPAWN_CAUSE,
						reason: `${claim.token} has claimed #${issue} for ${claim.ageMinutes} minute(s), past the ${claim.budgetMinutes}-minute budget for a build, ${why} — the claim itself is left standing for the \`spawn-dead\` unpark row to retract on the same proof`,
					},
					DEAD_SPAWN_EVENT,
					DEAD_SPAWN_CAUSE,
					"parked",
					"parkable",
					null,
					null,
				);

			// An epic child opens no pull request — one epic run is one branch and one PR, and the tail
			// owns it — so the branch read above IS this conjunct for a child, and there is no third read
			// to make. Asking the board anyway is what used to answer off a range read and then report it
			// as a PR that "did not settle".
			if (publication._tag === "LaneBranch") {
				yield* park(
					`and no lane branch for it in this clone — an epic child publishes onto its own lane branch and never onto a pull request, so that branch read is this conjunction's publication read and no board read was made`,
				);
				continue;
			}

			const published = yield* spawns.pulls(issue);
			if (published._tag === "Unknown") {
				hold(
					"unreadable",
					`whether an open PR links #${issue} could not be read: ${published.reason} — never read as dead`,
				);
				continue;
			}
			if (published.trace._tag === "One") {
				hold(
					"working",
					`#${published.trace.pr} is open and links #${issue}, so the builder published before it went quiet — a repair round carries that PR for its whole length, and a park would be wrong about a lane whose reviewer has an answer coming`,
				);
				continue;
			}
			// Several linking PRs is not "nothing published" — it is a board this reader cannot resolve
			// to one lane, and parking on it would call a lane abandoned over work somebody did.
			if (published.trace._tag === "Many") {
				hold(
					"unreadable",
					`${published.trace.prs.map((pr) => `#${pr}`).join(", ")} are open and link #${issue}, so which one this lane owns is not derivable here — never read as dead`,
				);
				continue;
			}

			yield* park(
				`with no lane branch in this clone and no open PR: ${published.trace.why} (${published.scanned} candidate(s) read)`,
			);
		}
		return rows;
	});

export const runRecover = <R = never>(
	options: RecoverOptions<R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		// Every root is listed before any lane is appended to, so an unreadable second root refuses a
		// run that has written nothing. Listing lazily used to refuse from inside the sweep, after the
		// first root's appends had landed: exit 11, empty stdout, and not one of the lanes it had just
		// moved named anywhere.
		const listings: Array<{root: string; names: ReadonlyArray<string>} | {root: string}> = [];
		for (const root of options.roots) {
			const probe = yield* Effect.result(exists(root));
			if (Result.isFailure(probe)) {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot establish whether ${root} is there: ${probe.failure.reason} — the lane set is UNKNOWN, never empty. Nothing was appended.`,
				);
			}
			if (!probe.success) {
				listings.push({root});
				continue;
			}
			const names = yield* Effect.result(readDir(root));
			if (Result.isFailure(names)) {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot list ${root}: ${names.failure.reason} — the lane set is UNKNOWN, never empty. Nothing was appended.`,
				);
			}
			listings.push({root, names: [...names.success].sort()});
		}

		const lanes: LaneRow[] = [];
		const scanned: Array<{root: string; present: boolean; lanes: number}> = [];
		for (const listing of listings) {
			if (!("names" in listing)) {
				scanned.push({root: listing.root, present: false, lanes: 0});
				continue;
			}
			let found = 0;
			for (const name of listing.names) {
				const rows = yield* recoverLane(listing.root, name, options);
				if (rows.length === 0) continue;
				found += 1;
				lanes.push(...rows);
			}
			scanned.push({root: listing.root, present: true, lanes: found});
		}

		const summary = Object.fromEntries(
			VERDICTS.map((verdict) => [verdict, lanes.filter((row) => row.verdict === verdict).length]),
		);
		const named = (verdict: Verdict) => lanes.filter((row) => row.verdict === verdict);
		const unappended = named("unappended");
		const contended = named("contended");
		const stderr = [
			`${VERB}: swept ${scanned.map((entry) => `${entry.root} (${entry.present ? `${entry.lanes} lane(s)` : "absent"})`).join(", ")}${options.spawns === null ? "" : " — spawn arm on"}${options.check ? " — check only, nothing appended" : ""}.`,
			...[...APPENDED, ...WITHHELD].flatMap((verdict) =>
				named(verdict).map(
					(row) =>
						`${VERB}: ${row.key}: ${row.event}${row.cause === undefined ? "" : ` --cause ${row.cause}`} on ${row.task} ${options.check ? "is proven and would move" : "was proven and moved"} the lane ${row.from} → ${row.to}.`,
				),
			),
			...[
				...named("working"),
				...named("refused"),
				...contended,
				...named("unreadable"),
				...unappended,
			].map((row) => `${VERB}: ${row.key}: ${row.reason ?? row.verdict}`),
			// A contended lane is the one exit-0 row with work left in it: its event is still the right
			// one and only the lock stood in the way, so the run says so in its own line rather than
			// leaving a reader to tell it from a refusal by the code on the row.
			...(contended.length === 0
				? []
				: [
						`${VERB}: ${contended.length} lane(s) only lost the ledger lock, so their event is still unrecorded and still valid: ${contended.map((row) => row.key).join(", ")}. Re-run this sweep once the holder clears.`,
					]),
		];
		// An append this run tried and could not land is the one row that may not sit on stdout beside
		// the ones that did: whether that lane is still missing its event is UNKNOWN, and a green sweep
		// listing it would read as swept. An unproven row is the opposite — the sweep proved there was
		// nothing to record — so it never refuses the run.
		if (unappended.length > 0) {
			const recovered = APPENDED.flatMap((verdict) => named(verdict));
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: ${unappended.length} lane(s) could not be appended to, so whether their artifact's event is still unrecorded is UNKNOWN: ${unappended.map((row) => row.key).join(", ")}. ${recovered.length} other lane(s) were recovered: ${recovered.map((row) => row.key).join(", ") || "none"}. Fix each named lane and re-run to sweep the rest.`,
				stderr,
			);
		}
		return answer(JSON.stringify({check: options.check, scanned, summary, lanes}, null, 2), stderr);
	});
