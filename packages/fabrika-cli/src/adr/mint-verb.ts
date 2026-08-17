/**
 * `adr mint` — allocate the next free id and scaffold its record in one invocation.
 *
 * `adr next` then `adr new` is two calls with an author's whole drafting turn between them, and an
 * id read in the first call is stale by the second: that check-to-mint gap is what put 0284 on two
 * pull requests and cost a dismissed approval (#5841). Fusing the pair does not make allocation
 * atomic across lanes — nothing local can, since an id only becomes visible to the in-flight set
 * when its pull request opens — but it removes the one window an author controls, leaving only the
 * mint-to-open window. Nothing closes that one downstream either: `decisions-index` now reads the
 * batched `merge_group` ref and reports a duplicate there, but that job is not a required context,
 * so the batch merges and the lane that opened second renumbers on `main` (#5869).
 *
 * Both halves are the existing ones: {@link resolveAllocation} is `adr next`'s read and
 * {@link scaffold} is `adr new`'s write, so this verb decides only the order and what it reports.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, type VerbOutcome} from "../verb.ts";
import {resolveAllocation} from "./allocation.ts";
import {refuseUnlessKebabSlug, scaffold} from "./new-verb.ts";

export interface MintOptions {
	readonly slug: string;
	readonly dir: string;
	readonly base: string;
	readonly repo: string | null;
	readonly status: string;
	readonly date: string;
	readonly title: string | null;
	readonly tags: string | null;
	readonly json: boolean;
}

export const runMint = (
	options: MintOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const {slug, dir, base, repo, status, date, title, tags, json} = options;

		const badSlug = refuseUnlessKebabSlug(slug, "adr mint");
		if (badSlug !== null) return badSlug;

		const resolved = yield* resolveAllocation({verb: "adr mint", dir, base, repo});
		if (resolved._tag === "Refused") return resolved.outcome;
		const {allocation, baseSha, scope} = resolved.value;

		const written = yield* scaffold(
			{id: allocation.id, slug, dir, status, date, title, tags},
			"adr mint",
		);
		// The scope line rides the refusal too: an id that turns out to be taken on disk is only
		// readable against the sets it was allocated from.
		if (written._tag === "Refused") {
			return {...written.outcome, stderr: [scope, ...written.outcome.stderr]};
		}

		return answer(
			json
				? JSON.stringify({
						path: written.path,
						id: allocation.id,
						slug,
						mergedMax: allocation.mergedMax,
						inFlight: allocation.inFlight,
						baseRef: base,
						baseSha,
					})
				: written.path,
			[scope],
		);
	});
