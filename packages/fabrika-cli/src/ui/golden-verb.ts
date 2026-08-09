/**
 * `ui golden` — resolve a surface's blessed golden and diff a candidate against it.
 *
 * **Signal, never verdict.** No threshold lives in this verb and no PASS/FAIL token is reachable from
 * it; the acceptance fork is `review-ui`'s (#4718). It reads the pointer and the bytes and writes
 * neither: blessing stays the founder gallery flow (ADR 0183 §5).
 *
 * A missing golden is a **fact** (`blessed: false`, exit 0) — but only after a pointer read that
 * succeeded. The unreadable pointer resolving to an empty blessed set is #4501, and `4`/`11` are
 * where that fail-open goes to die.
 *
 * The fetched bytes are cached content-addressed under the OS temp root, which makes the cache
 * lane-independent by construction: a content-addressed file is write-once, so concurrent lanes
 * cannot clobber each other and this verb needs no lane precondition to stay safe.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {readBytes, writeBytes} from "./bytes.ts";
import {BAD_SECTIONS, CAPTURE_INVALID, PRECONDITION_UNKNOWN} from "./codes.ts";
import {atRoot, GOLDEN_POINTER_PATHS} from "./conventions.ts";
import {diffAgainstGolden, REGION_CAP} from "./diff.ts";
import {resolveRoot} from "./lane.ts";
import {probe} from "./manifest-verb.ts";
import {decodePng, sha256Of} from "./png.ts";
import {goldenUrl, parsePointer} from "./pointer.ts";

const VERB = "ui golden";

/** The injected fetch of blessed bytes — a store the consuming repo owns, never one fabrika names. */
export type FetchLeg = (
	url: string,
) => Effect.Effect<
	| {readonly _tag: "Ok"; readonly bytes: Uint8Array}
	| {readonly _tag: "Failed"; readonly reason: string}
>;

export interface GoldenOptions {
	readonly surface: string;
	readonly candidate: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The OS temp root, read by the adapter — the one machine fact this verb does not derive. */
	readonly tmpRoot: string;
	readonly fetch: FetchLeg;
}

const unresolvable = (surface: string, reason: string): VerbOutcome =>
	refuse(
		PRECONDITION_UNKNOWN,
		`${VERB}: cannot resolve the golden for "${surface}": ${reason} — blessing is UNKNOWN, never "unblessed".`,
	);

const unblessed = (surface: string, note: string): VerbOutcome =>
	answer(JSON.stringify({surface, blessed: false, golden: null, diff: null}), [`${VERB}: ${note}`]);

export const runGolden = (
	options: GoldenOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const {surface} = options;
		const root = yield* resolveRoot(VERB);
		if (root._tag === "Refused") return root.outcome;

		let pointerPath: string | null = null;
		for (const relative of GOLDEN_POINTER_PATHS) {
			const found = yield* probe(root.root, relative);
			if (found._tag === "Unknown") return unresolvable(surface, found.reason);
			if (found._tag === "Present") {
				pointerPath = atRoot(root.root, relative);
				break;
			}
		}
		if (pointerPath === null) {
			return unblessed(
				surface,
				"no golden pointer at either convention path — no surface is blessed.",
			);
		}

		const raw = yield* readBytes(pointerPath);
		if (raw._tag === "Failed") return unresolvable(surface, raw.reason);
		const parsed = parsePointer(new TextDecoder().decode(raw.bytes));
		if (parsed._tag === "Violation") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: the golden pointer exists but does not parse: ${parsed.violation} — refusing; an unreadable pointer is not an empty blessed set.`,
			);
		}
		const sha256 = parsed.pointer.surfaces[surface];
		if (sha256 === undefined) {
			return unblessed(surface, `the pointer names no golden for "${surface}".`);
		}
		const store = parsed.pointer.store;
		if (store === null) return unresolvable(surface, "the pointer declares no store");

		const cachePath = `${options.tmpRoot.replace(/\/+$/, "")}/fabrika-ui-goldens/${sha256}.png`;
		const cached = yield* readBytes(cachePath);
		let goldenBytes: Uint8Array;
		if (cached._tag === "Bytes" && sha256Of(cached.bytes) === sha256) {
			goldenBytes = cached.bytes;
		} else {
			const fetched = yield* options.fetch(goldenUrl(store, sha256));
			if (fetched._tag === "Failed") return unresolvable(surface, fetched.reason);
			if (sha256Of(fetched.bytes) !== sha256) {
				return unresolvable(
					surface,
					`the store answered bytes that hash to something other than ${sha256}`,
				);
			}
			const failure = yield* writeBytes(cachePath, fetched.bytes);
			if (failure !== null) return unresolvable(surface, `cannot cache the golden: ${failure}`);
			goldenBytes = fetched.bytes;
		}
		const golden = {sha256, path: cachePath};

		if (options.candidate === null) {
			return answer(JSON.stringify({surface, blessed: true, golden, diff: null}), [
				`${VERB}: resolved the blessed golden for "${surface}"; no candidate to diff.`,
			]);
		}

		const invocationDir = options.env.FABRIKA_INVOCATION_DIR ?? root.root;
		const candidatePath = options.candidate.startsWith("/")
			? options.candidate
			: `${invocationDir.replace(/\/+$/, "")}/${options.candidate}`;
		const candidateBytes = yield* readBytes(candidatePath);
		if (candidateBytes._tag === "Failed") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the candidate at ${candidatePath}: ${candidateBytes.reason} — the diff is UNKNOWN.`,
			);
		}
		const candidateImage = decodePng(candidateBytes.bytes);
		if (candidateImage._tag === "Invalid") {
			return refuse(
				CAPTURE_INVALID,
				`${VERB}: the candidate at ${candidatePath} is invalid (${candidateImage.detail}).`,
			);
		}
		const goldenImage = decodePng(goldenBytes);
		if (goldenImage._tag === "Invalid") {
			return unresolvable(
				surface,
				`the blessed bytes are not a decodable PNG (${goldenImage.detail})`,
			);
		}
		const outcome = diffAgainstGolden(goldenImage.image, candidateImage.image);
		const notes = [`${VERB}: diffed "${surface}" against its blessed golden.`];
		if (outcome.capped) {
			notes.push(
				`${VERB}: ${outcome.found} regions differ; the list is capped at ${REGION_CAP}, largest area first.`,
			);
		}
		return answer(JSON.stringify({surface, blessed: true, golden, diff: outcome.diff}), notes);
	});
