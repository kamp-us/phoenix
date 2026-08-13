/**
 * `epic verdict` — one slice verdict, bound to the commit in the local graph.
 *
 * **What a slice verdict binds to with no pushed head is the commit SHA**, and that is what makes an
 * unpushed-slice review specifiable at all: a SHA is content-addressed, so any amend or rebase
 * yields a different one and the old verdict goes `unbindable` against the new graph — a stale slice
 * verdict is unrepresentable rather than merely detectable (ADR 0058's shape).
 *
 * The marker is composed by the imported `wire/verdict-marker.ts` `emit` under the namespace
 * `slice:<id>`, its clause the body's first line — which is what makes `next`'s Fix-First injection
 * a derivation over the ledger rather than a second authored string (H3).
 *
 * A local ledger has no ACL, so authority here is the lane guard — the claim and the tree. That is
 * why only a claim-holding session can record one, and why the final PR-scope review, which does
 * carry ACL-checked authority (ADR 0055), stays exactly as it is.
 */
import {Effect, FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {badNumber} from "../build/target.ts";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {headSha as brandSha, clause, emit as emitMarker} from "../wire/verdict-marker.ts";
import {appendLine} from "./append.ts";
import {
	BREAKER_TRIPPED,
	COMMIT_NOT_IN_GRAPH,
	EMPTY_STDIN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {breakerFor} from "./fold.ts";
import {resolveCommit} from "./graph.ts";
import {forSlice, nextSeq, verdictBodyPath} from "./ledger.ts";
import {laneGround, loadRun} from "./run.ts";

const VERB = "epic verdict";

const HEX = /^[0-9a-f]{7,40}$/;

export interface VerdictOptions {
	readonly number: number;
	readonly slice: string;
	readonly commit: string;
	readonly polarity: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly at: string;
	readonly stdin: Effect.Effect<StdinRead>;
}

export const runVerdict = (
	options: VerdictOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const epic = options.number;
		const bad = badNumber(VERB, "an issue number", epic);
		if (bad !== null) return bad;

		// The stdin read is handled here rather than through `build/authored.ts` because that guard
		// also refuses a bare `@` path on `6` — a code no `epic` verb reaches, since a verdict body
		// lands in the ledger and is never posted. What is kept is the discipline that matters: an
		// UNREAD pipe is `11` and a read-but-empty one is `3`, and the two never collapse (#3924).
		const read = yield* options.stdin;
		if (read._tag === "Failed") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: could not read stdin: ${read.reason} — the body is UNKNOWN, never empty.`,
			);
		}
		const body = read._tag === "NoStdin" ? "" : read.text;
		const first = body.split("\n").find((line) => line.trim() !== "") ?? "";
		if (first.trim() === "") {
			return refuse(EMPTY_STDIN, `${VERB}: no body on stdin — an empty verdict grades nothing.`);
		}
		const polarity = options.polarity.toUpperCase();
		if (polarity !== "PASS" && polarity !== "FAIL") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --polarity must be PASS or FAIL — got "${options.polarity}".`,
			);
		}
		if (!HEX.test(options.commit.trim().toLowerCase())) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --commit "${options.commit}" is not 7–40 lowercase hex.`,
			);
		}

		const ground = yield* laneGround(VERB, epic, null, options.env);
		if (ground._tag === "Refused") return ground.outcome;

		const run = yield* loadRun(VERB, epic, ground);
		if (run._tag === "Refused") return run.outcome;

		const slice = options.slice;
		if (!run.plan.slices.some((row) => row.id === slice)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: slice "${slice}" is not in run ${run.plan.run}.`,
				ground.notes,
			);
		}

		const resolved = yield* resolveCommit(options.commit.trim());
		if (resolved === null) {
			return refuse(
				COMMIT_NOT_IN_GRAPH,
				`${VERB}: ${options.commit.trim()} is not in this branch's local graph.`,
				ground.notes,
			);
		}
		const landed =
			forSlice(run.lines, slice)
				.filter((line) => line.event === "slice-landed")
				.at(-1)?.sha ?? null;
		if (landed === null || landed !== resolved) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --commit ${options.commit.trim()} is not slice "${slice}"'s landed commit (${landed ?? "none recorded"}) — a verdict binds what landed.`,
				ground.notes,
			);
		}

		const axis = breakerFor(run.lines, slice);
		if (axis !== null) {
			return refuse(
				BREAKER_TRIPPED,
				`${VERB}: slice "${slice}"'s ${axis} breaker is at cap — escalate; the run records no further verdict for it.`,
				ground.notes,
			);
		}

		const sha = brandSha(resolved);
		const text = clause(first);
		if (sha === null || text === null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: the verdict's commit or first line cannot carry a marker.`,
				ground.notes,
			);
		}
		const marker = emitMarker({
			namespace: `slice:${slice}`,
			polarity,
			sha,
			content: null,
			clause: text,
		}).trimEnd();

		const fs = yield* FileSystem.FileSystem;
		const bodyPath = verdictBodyPath(ground.dir, slice, resolved);
		const wrote = yield* fs
			.makeDirectory(bodyPath.slice(0, bodyPath.lastIndexOf("/")), {recursive: true})
			.pipe(
				Effect.andThen(fs.writeFileString(bodyPath, body)),
				Effect.as(null),
				Effect.catchTag("PlatformError", (cause) => Effect.succeed(cause.message)),
			);
		if (wrote !== null) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the verdict body could not be stored (${wrote}) — the verdict is UNKNOWN.`,
				ground.notes,
			);
		}

		const seq = nextSeq(run.lines);
		const appended = yield* appendLine(ground.dir, {
			seq,
			at: options.at,
			event: "verdict-recorded",
			slice,
			detail: marker,
			sha: null,
		});
		if (appended._tag === "Unknown") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the append could not be proven (${appended.reason}) — the ledger state is UNKNOWN.`,
				ground.notes,
			);
		}
		if (appended._tag === "Mismatch") {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the append landed but the tail does not read back — the ledger needs a human eye.`,
				ground.notes,
			);
		}
		return answer(
			JSON.stringify({answer: "recorded", slice, polarity, commit: resolved, seq}),
			ground.notes,
		);
	});
