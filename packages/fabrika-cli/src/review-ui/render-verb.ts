/**
 * `review-ui render` — capture named surfaces from the PR's preview deployment at the inspected
 * head, one validated PNG per surface, each surface's outcome proven.
 *
 * The order is the contract's and every step gates the next: resolve the PR and its live head,
 * resolve the announced preview, **bind the preview to the head**, then render each surface and
 * classify what came back. Full success is the only `0` — v1's capture leg carried no status
 * assertion and no capture-count check, so a crashed helper meant zero surfaces judged, zero
 * violations, PASS (#3925).
 *
 * The renderer is an injected seam ({@link RenderLeg}) so every refusal below is testable without a
 * browser; `render-leg.ts` is the one that drives the capture machinery.
 *
 * A surface may name a state (`/pano:auth`), but only one this repo can actually put on screen —
 * the vocabulary and its mechanism live in `capture/states.ts`. Anything else is refused rather
 * than shot, because a state nothing renders captures the default pixels under a variant's name,
 * which is coverage claimed and not held (#7051).
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {readIdentity, sessionCookies} from "../capture/auth.ts";
import type {CaptureCookie} from "../capture/capture.ts";
import {isRealizedState, REALIZED_STATES, stateOf} from "../capture/states.ts";
import {writeFile} from "../io/fs.ts";
import {listComments} from "../io/issues.ts";
import {openPull, resolveTargetRepo, scannedLine} from "../review/target.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	INVALID_CAPTURE,
	NO_PREVIEW,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	RENDER_CRASHED,
	STALE_TREE,
	SURFACE_UNREACHABLE,
} from "./codes.ts";
import {
	type CaptureEntry,
	type CaptureManifest,
	isKebabSetName,
	manifestPath,
	serializeManifest,
	setDirectory,
} from "./manifest.ts";
import {resolvePreview} from "./preview.ts";

const VERB = "review-ui render";

/** What one surface's render is asked for: the preview it hangs off, and where its PNG belongs. */
export interface SurfaceRenderRequest {
	/** The surface id — `<route>` or `<route>:<state>`. */
	readonly surface: string;
	readonly previewUrl: string;
	readonly outDir: string;
	/** Seeded into the capture context before navigation. Empty ⇒ the anonymous render. */
	readonly cookies: readonly CaptureCookie[];
}

/**
 * One surface's proven outcome. Four arms, never three: an execution that never became answerable
 * (`Failed`) is UNKNOWN and must not read as a surface that rendered badly.
 */
export type SurfaceRender =
	| {readonly _tag: "Rendered"; readonly entry: CaptureEntry}
	| {readonly _tag: "Unreachable"; readonly reason: string}
	| {readonly _tag: "Crashed"; readonly firstError: string}
	| {readonly _tag: "Invalid"; readonly detail: string}
	| {readonly _tag: "Failed"; readonly reason: string};

export type RenderLeg = (request: SurfaceRenderRequest) => Effect.Effect<SurfaceRender>;

export interface RenderOptions {
	readonly pr: number;
	readonly out: string;
	readonly surfaces: readonly string[];
	readonly app: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The OS temp root the deterministic set path hangs off — a port so a test can pin it. */
	readonly tmpRoot: string;
	readonly render: RenderLeg;
}

const unreadable = (what: string, pr: number, reason: string): VerbOutcome =>
	refuse(
		PRECONDITION_UNKNOWN,
		`${VERB}: cannot read ${what} for #${pr}: ${reason} — the render is UNKNOWN.`,
	);

/** Either side may be abbreviated, so the match is a prefix in whichever direction is shorter. */
const prefixMatch = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

const shortSha = (sha: string): string => sha.slice(0, 7);

/**
 * The reported code when per-surface outcomes mix: the **smallest** applicable of `13`/`14`/`15`.
 *
 * The code routes and the stderr enumerates. Dropping a surface is the skill's explicit
 * re-invocation without it, on the record — never this verb's tolerance.
 */
const routeCode = (renders: readonly SurfaceRender[]): number | null => {
	if (renders.some((r) => r._tag === "Crashed")) return RENDER_CRASHED;
	if (renders.some((r) => r._tag === "Unreachable")) return SURFACE_UNREACHABLE;
	if (renders.some((r) => r._tag === "Invalid")) return INVALID_CAPTURE;
	return null;
};

const outcomeLine = (surface: string, render: SurfaceRender): string => {
	switch (render._tag) {
		case "Rendered": {
			// The count is the whole tally, not the kept rows: the payload collapses the list, so a
			// stderr count read off `rows` alone would under-report exactly when there is most to report.
			const errors = render.entry.pageErrors;
			return `${VERB}: surface "${surface}" captured: ${render.entry.width}x${render.entry.height}, ${errors.rows.length + errors.more} page error(s)`;
		}
		case "Unreachable":
			return `${VERB}: surface "${surface}" is unreachable at the preview (${render.reason}) — judge what renders, and hold the gap against the PR's Deviations (#4305).`;
		case "Crashed":
			return `${VERB}: surface "${surface}" threw during render: ${render.firstError} — the render is red; a broken page is not composition to judge.`;
		case "Invalid":
			return `${VERB}: surface "${surface}" captured invalid bytes (${render.detail}) — a capture nobody can open is not evidence (#3925's class).`;
		case "Failed":
			return `${VERB}: surface "${surface}" could not be rendered: ${render.reason} — the outcome is UNKNOWN.`;
	}
};

export const runRender = (
	options: RenderOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const {pr} = options;
		if (!Number.isInteger(pr) || pr <= 0) {
			return refuse(FAILED, `${VERB}: ${pr} is not a pull-request number.`);
		}
		if (options.surfaces.length === 0) {
			return refuse(
				FAILED,
				`${VERB}: no --surface operands — "rendered nothing, found nothing wrong" is not an answer (ADR 0092).`,
			);
		}
		if (!isKebabSetName(options.out)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --out "${options.out}" is not a kebab-case set name.`,
			);
		}
		// A state is admitted only when something puts it on screen. Parsing one and shooting the
		// default pixels under a variant's name is coverage claimed and not held (#7051).
		const unrealized = options.surfaces.find((surface) => {
			const state = stateOf(surface);
			return state !== null && !isRealizedState(state);
		});
		if (unrealized !== undefined) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --surface "${unrealized}" names a :state nothing renders — the realized states are ${REALIZED_STATES.join(", ")}; render the bare route.`,
			);
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openPull(VERB, repo, pr, {
			requireOpen: true,
			closedReason: "nothing to judge.",
			requireFiles: false,
			unknownMessage: (reason) =>
				`${VERB}: cannot read the PR for #${pr}: ${reason} — the render is UNKNOWN.`,
		});
		if (target._tag === "Refused") return target.outcome;
		const head = target.pull.headSha;

		const comments = yield* listComments(repo, pr);
		if (comments._tag === "Failure") return unreadable("the comments", pr, comments.reason);
		const scanned = scannedLine(VERB, comments.value.length, "comment");

		const preview = resolvePreview(comments.value, options.app);
		if (preview._tag === "NoPreview") {
			return refuse(
				NO_PREVIEW,
				`${VERB}: no preview-deploy comment on PR #${pr} — nothing to judge without running the PR's code; the run is CANT-SEE.`,
				[scanned],
			);
		}
		if (preview._tag === "Ambiguous") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: the preview comment names apps ${preview.apps.join(", ")} — pass --app to pick one.`,
				[scanned],
			);
		}
		if (preview._tag === "Malformed") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: the preview comment carries the anchor but no parseable URL + SHA (${preview.reason}) — a malformed announcement is unreadable, not absent.`,
				[scanned],
			);
		}
		const announced = preview.value;

		// The pixels bind the tree they were taken from. A preview that lags the push would stamp an
		// old tree with a new head — the stale-verdict class at the capture seam (#4808, ADR 0058).
		if (!prefixMatch(head, announced.deployedSha)) {
			return refuse(
				STALE_TREE,
				`${VERB}: the preview deploys ${shortSha(announced.deployedSha)}, the live head is ${shortSha(head)} — stale preview; pixels of an old tree must not bind a new head (#4808's class).`,
				[scanned],
			);
		}

		// An `:auth` surface rendered without credentials would come back as the visitor's page under
		// the signed-in name — the "unseen ground reading as clean" this whole axis exists to stop —
		// so a missing half of the pair is UNKNOWN here, before a browser launches.
		const wantsAuth = options.surfaces.some((surface) => stateOf(surface) === "auth");
		const identity = readIdentity(options.env);
		if (wantsAuth) {
			if (identity === null) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: an :auth surface was requested but neither PREVIEW_TEST_SESSION_TOKEN nor BETTER_AUTH_SECRET is set — the authenticated render is UNKNOWN, never the anonymous one.`,
					[scanned],
				);
			}
			if ("missing" in identity) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: an :auth surface was requested but ${identity.missing} is unset — the authenticated render is UNKNOWN, never the anonymous one.`,
					[scanned],
				);
			}
		}
		const authCookies: readonly CaptureCookie[] =
			identity !== null && !("missing" in identity)
				? sessionCookies(announced.url, identity.token, identity.secret)
				: [];

		const setDir = setDirectory(options.tmpRoot, pr, head, options.out);
		const renders: SurfaceRender[] = [];
		for (const surface of options.surfaces) {
			renders.push(
				yield* options.render({
					surface,
					previewUrl: announced.url,
					outDir: setDir,
					// Only the `:auth` variant carries the session; a bare route stays the visitor's
					// render, so the two are genuinely different pixels rather than one shot twice.
					cookies: stateOf(surface) === "auth" ? authCookies : [],
				}),
			);
		}
		const enumerated = [
			scanned,
			...options.surfaces.map((surface, i) => outcomeLine(surface, renders[i] as SurfaceRender)),
		];

		const failed = renders.find((render) => render._tag === "Failed");
		if (failed !== undefined && failed._tag === "Failed") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read a capture's validity for #${pr}: ${failed.reason} — the render is UNKNOWN.`,
				enumerated,
			);
		}
		const routed = routeCode(renders);
		if (routed !== null) {
			// The refusal names a surface the ROUTED code applies to, not merely the first bad one: a
			// message about an unreachable surface over a `13` would send the caller after the wrong fix.
			const tag =
				routed === RENDER_CRASHED
					? "Crashed"
					: routed === SURFACE_UNREACHABLE
						? "Unreachable"
						: "Invalid";
			const index = renders.findIndex((render) => render._tag === tag);
			return refuse(
				routed,
				outcomeLine(options.surfaces[index] as string, renders[index] as SurfaceRender),
				enumerated,
			);
		}

		const manifest: CaptureManifest = {
			set: options.out,
			pr,
			head,
			previewUrl: announced.url,
			captures: renders.map((render) => (render as {entry: CaptureEntry}).entry),
		};
		const document = serializeManifest(manifest);
		// A set without its manifest is not a set: `post` reads the set through it, so a manifest that
		// did not land makes the captures unusable as evidence and the run UNKNOWN.
		const written = yield* Effect.result(writeFile(manifestPath(setDir), document));
		if (Result.isFailure(written)) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot write the set manifest for #${pr}: ${written.failure.reason} — the captures exist but the set does not.`,
				enumerated,
			);
		}
		return answer(document, enumerated);
	});
