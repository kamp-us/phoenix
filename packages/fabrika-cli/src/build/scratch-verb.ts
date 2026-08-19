/**
 * `build scratch` — the per-lane scratch path, allocated fail-closed.
 *
 * `<temp root>/fabrika-build/<session-id>/<issue>-<claim-nonce>/<slug>`. The fixed `fabrika-build`
 * segment namespaces the allocator against everything else in the temp root; **the claim nonce is what
 * v1's allocator lacked**. v1 keyed on the session id alone, so two lanes — or two roles — of one
 * session shared a namespace and clobbered each other's fixed-name files (#4516, #4544, #4875, #4692),
 * and its own stamp could not separate two pid-less runs (`scratchpad.ts:26-29`). Keying on the
 * confirmed claim makes the namespace per-lane by construction rather than by convention — on the
 * nonce of the token the CALLER holds, never the winning marker's, which is the same string for two
 * lanes of one session (#6037).
 *
 * The printed path is machine-local by definition and must never reach a posted artifact — which is
 * why `build pr` and `build note` red on it (`5`).
 */
import {Effect, FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {requireCallerToken, requireClaim, requireSession} from "./claim.ts";
import {OFF_VOCABULARY} from "./codes.ts";
import {isKebabSlug} from "./lane.ts";
import {resolveTargetRepo} from "./target.ts";

const VERB = "build scratch";

/**
 * The lane's namespace, exported so a sibling group that writes into this lane's scratch derives the
 * path rather than restating the formula — the `ui` group's capture sets land under it.
 */
export const laneScratchDir = (
	tmpRoot: string,
	session: string,
	number: number,
	nonce: string,
): string => `${tmpRoot.replace(/\/+$/, "")}/fabrika-build/${session}/${number}-${nonce}`;

export interface ScratchOptions {
	readonly number: number;
	readonly slug: string;
	/** The token `build claim` handed this lane — what keys the namespace per lane (#6037). */
	readonly token: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The OS temp root, read by the adapter — the one machine fact this verb does not derive. */
	readonly tmpRoot: string;
}

export const runScratch = (
	options: ScratchOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const {number, slug} = options;
		if (slug.includes("/") || slug.includes("\\") || !isKebabSlug(slug)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --slug "${slug}" must be a kebab-case leaf, no path separators.`,
			);
		}
		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		const asking = requireCallerToken(VERB, session.id, options.token);
		if (asking._tag === "Refused") return asking.outcome;

		const held = yield* requireClaim(VERB, resolved.repo, number, asking.caller);
		if (held._tag === "Refused") return held.outcome;

		const dir = laneScratchDir(options.tmpRoot, session.id, number, asking.caller.nonce);
		const fs = yield* FileSystem.FileSystem;
		const made: string | null = yield* fs.makeDirectory(dir, {recursive: true}).pipe(
			Effect.as(null),
			Effect.catchTag("PlatformError", (cause) => Effect.succeed(cause.message)),
		);
		return made === null
			? answer(`${dir}/${slug}`, held.notes)
			: refuse(FAILED, `${VERB}: cannot create ${dir}: ${made}`, held.notes);
	});
