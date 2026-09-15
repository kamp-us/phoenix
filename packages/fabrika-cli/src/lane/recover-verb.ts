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
 * re-run rather than a lane moved on a read nobody made. The `BLOCKED` a reviewer's park claims is
 * out of scope by the same reasoning, and `./recover.ts` carries why.
 *
 * Each recoverable lane costs two board reads rather than one: this sweep asks the proof what the
 * answer is, and `lane transition` asks it again under its own gate before it appends. That second
 * read is the gate refusing to take this sweep's word for it, which is the property worth the read —
 * and it is paid only by a lane that is actually recoverable, which is a killed shell's lane and not
 * a busy one. `--check` pays the first read alone and appends nothing.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import type {ParkCauseSurface} from "../config/keys/park-cause.ts";
import type {Read} from "../config/read-key.ts";
import {exists, readDir} from "../io/fs.ts";
import {ANSWER, answer, refuse, type VerbOutcome} from "../verb.ts";
import {APPEND_UNKNOWN, LANE_UNREADABLE} from "./codes.ts";
import {applyEvent, deriveStatus, foldLog, standingCauses} from "./fold.ts";
import {CHORE_PREFIX} from "./key.ts";
import type {ProofOutcome, ProveOptions} from "./prove-verb.ts";
import {owedBy} from "./recover.ts";
import {DEFAULT_CHORES_ROOT, loadLane} from "./store.ts";
import {runTransition} from "./transition-verb.ts";

const VERB = "fabrika lane recover";

export interface RecoverOptions<R = never> {
	readonly roots: ReadonlyArray<string>;
	/** Judge every lane and report what would be appended, appending nothing. */
	readonly check: boolean;
	/**
	 * The proof, as a parameter rather than an import, so this verb's unit tier stays offline — the
	 * shape `lane transition` established, and this hands the very same prover on to it.
	 */
	readonly prove: (options: ProveOptions) => Effect.Effect<ProofOutcome, never, R>;
	/**
	 * The repo's `parkCause`, passed through to the append untouched.
	 *
	 * Inert here by construction — this sweep records a `DONE` or a `PASS` and never a park — but it
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
	| "unproven"
	| "refused"
	| "current"
	| "terminal"
	| "unreadable"
	| "unappended";

const VERDICTS: ReadonlyArray<Verdict> = [
	"recovered",
	"recoverable",
	"unproven",
	"refused",
	"current",
	"terminal",
	"unreadable",
	"unappended",
];

interface LaneRow {
	readonly key: string;
	readonly root: string;
	readonly verdict: Verdict;
	/** The task judged, and the leaf it stands in; absent where no task was reached. */
	readonly task?: string;
	readonly state?: string;
	/** The event that leaf owes; absent where the leaf owes none. */
	readonly event?: string;
	/**
	 * Which of `lane prove`'s answers came back, and at which exit — `proof` is `null` on a refusal,
	 * where the code carries the whole answer, and the two together are what tells a `not-required`
	 * from an unreadable board without re-reading anything.
	 */
	readonly proof?: string | null;
	readonly proofCode?: number;
	/** What the lane folds to now, and what the recovered event would fold it to. */
	readonly from?: string;
	readonly to?: string;
	readonly reason?: string;
}

const keyOf = (root: string, name: string): string =>
	root.endsWith(DEFAULT_CHORES_ROOT) ? `${CHORE_PREFIX}${name}` : name;

const printable = (
	value: string | Readonly<Record<string, Readonly<Record<string, string>> | string>>,
): string => (typeof value === "string" ? value : JSON.stringify(value));

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

		const status = deriveStatus(loaded.lane, folded.states, standingCauses(loaded.entries));
		if (status.status === "done") {
			return [{key, root, verdict: "terminal" as const, from: printable(status.stateValue)}];
		}
		const owed = owedBy(status);
		if (owed.length === 0) {
			return [{key, root, verdict: "current" as const, from: printable(status.stateValue)}];
		}

		const rows: LaneRow[] = [];
		for (const {task, leaf, event} of owed) {
			const base = {key, root, task, state: leaf, event, from: printable(status.stateValue)};
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

			// The preview is taken offline off the same applier the append runs, so a `--check` row and
			// the append it predicts cannot disagree about where the lane lands.
			const applied = applyEvent(
				loaded.lane,
				folded.states,
				task,
				event,
				new Date(0).toISOString(),
				null,
				null,
				proof.partial,
				proof.diagnosis ? true : null,
				null,
			);
			if (applied._tag === "Refused") {
				rows.push({
					...base,
					verdict: "refused",
					proof: proof.proof,
					proofCode: proof.code,
					reason: `the artifact proves the ${event}, and this lane's own machine refuses it: ${applied.reason}`,
				});
				continue;
			}
			const to = printable(applied.current.stateValue);
			if (options.check) {
				rows.push({...base, verdict: "recoverable", proof: proof.proof, proofCode: proof.code, to});
				continue;
			}

			// The append is `lane transition`'s whole path — its machine validation, its proof gate and
			// its ledger lock — so nothing here is a second way onto a lane's log.
			const recorded = yield* runTransition(
				{
					root,
					lane: name,
					event,
					task,
					cause: null,
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
				rows.push({...base, verdict: "recovered", proof: proof.proof, proofCode: proof.code, to});
				continue;
			}
			const why = recorded.stderr[recorded.stderr.length - 1] ?? "no reason given";
			rows.push({
				...base,
				verdict: recorded.code === APPEND_UNKNOWN ? "unappended" : "refused",
				proof: proof.proof,
				proofCode: proof.code,
				to,
				reason: `the append refused at ${recorded.code}: ${why}`,
			});
		}
		return rows;
	});

export const runRecover = <R = never>(
	options: RecoverOptions<R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const lanes: LaneRow[] = [];
		const scanned: Array<{root: string; present: boolean; lanes: number}> = [];
		for (const root of options.roots) {
			const probe = yield* Effect.result(exists(root));
			if (Result.isFailure(probe)) {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot establish whether ${root} is there: ${probe.failure.reason} — the lane set is UNKNOWN, never empty.`,
				);
			}
			if (!probe.success) {
				scanned.push({root, present: false, lanes: 0});
				continue;
			}
			const names = yield* Effect.result(readDir(root));
			if (Result.isFailure(names)) {
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: cannot list ${root}: ${names.failure.reason} — the lane set is UNKNOWN, never empty.`,
				);
			}
			let found = 0;
			for (const name of [...names.success].sort()) {
				const rows = yield* recoverLane(root, name, options);
				if (rows.length === 0) continue;
				found += 1;
				lanes.push(...rows);
			}
			scanned.push({root, present: true, lanes: found});
		}

		const summary = Object.fromEntries(
			VERDICTS.map((verdict) => [verdict, lanes.filter((row) => row.verdict === verdict).length]),
		);
		const named = (verdict: Verdict) => lanes.filter((row) => row.verdict === verdict);
		const unappended = named("unappended");
		const stderr = [
			`${VERB}: swept ${scanned.map((entry) => `${entry.root} (${entry.present ? `${entry.lanes} lane(s)` : "absent"})`).join(", ")}${options.check ? " — check only, nothing appended" : ""}.`,
			...[...named("recovered"), ...named("recoverable")].map(
				(row) =>
					`${VERB}: ${row.key}: ${row.event} on ${row.task} ${options.check ? "is proven and would move" : "was proven and moved"} the lane ${row.from} → ${row.to}.`,
			),
			...[...named("refused"), ...named("unreadable"), ...unappended].map(
				(row) => `${VERB}: ${row.key}: ${row.reason ?? row.verdict}`,
			),
		];
		// An append this run tried and could not land is the one row that may not sit on stdout beside
		// the ones that did: whether that lane is still missing its event is UNKNOWN, and a green sweep
		// listing it would read as swept. An unproven row is the opposite — the sweep proved there was
		// nothing to record — so it never refuses the run.
		if (unappended.length > 0) {
			const recovered = named("recovered");
			return refuse(
				APPEND_UNKNOWN,
				`${VERB}: ${unappended.length} lane(s) could not be appended to, so whether their artifact's event is still unrecorded is UNKNOWN: ${unappended.map((row) => row.key).join(", ")}. ${recovered.length} other lane(s) were recovered: ${recovered.map((row) => row.key).join(", ") || "none"}. Fix each named lane and re-run to sweep the rest.`,
				stderr,
			);
		}
		return answer(JSON.stringify({check: options.check, scanned, summary, lanes}, null, 2), stderr);
	});
