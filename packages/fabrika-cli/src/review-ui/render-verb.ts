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
 * which is coverage claimed and not held (#7051). An `:auth` surface is refused twice over: on `11`
 * before a browser launches when the credentials are incomplete, and on `11` again when the shot's
 * own session proof does not come back signed in — a cookie that failed to authenticate produces a
 * perfectly valid PNG of the visitor's page, which no byte check can tell from the real thing.
 *
 * `--flag <key>=<on|off>` forces a dark-shipped flag for the run (ADR 0336, #7218), and it is
 * refused twice over on the same shape: on `10` when an operand is unreadable or names an anonymous
 * surface — the preview honors the override cookie only for an authorized platform-admin actor — and
 * on `11` when the shot's own flag probe says the forced key evaluated at its default anyway.
 */
import {Effect, type FileSystem, type Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {readIdentity, sessionCookies} from "../capture/auth.ts";
import type {CaptureCookie} from "../capture/capture.ts";
import {
	FORCED_VALUES,
	type ForcedFlags,
	isForcing,
	NO_FORCED_FLAGS,
	overrideCookies,
	parseFlagOperands,
} from "../capture/flag-override.ts";
import {isRealizedState, provesSession, REALIZED_STATES, stateOf} from "../capture/states.ts";
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
	mintPreviewProvenance,
	PREVIEW_PROVENANCE_RECEIPT,
	previewProvenanceKeyPath,
	serializeManifest,
	setDirectory,
	sha256Hex,
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
	/**
	 * The flags {@link cookies}' override cookie forces, so the leg can ask the preview what they
	 * evaluated to. Empty ⇒ nothing was forced and no proof is owed.
	 */
	readonly forcedFlags: ForcedFlags;
}

/**
 * One surface's proven outcome. An execution that never became answerable (`Failed`) is UNKNOWN and
 * must not read as a surface that rendered badly; `Unauthenticated` is UNKNOWN for the same reason,
 * one layer up — the page rendered fine, it is just not the page that was asked for.
 */
export type SurfaceRender =
	| {readonly _tag: "Rendered"; readonly entry: CaptureEntry}
	| {readonly _tag: "Unreachable"; readonly reason: string}
	| {readonly _tag: "Crashed"; readonly firstError: string}
	| {readonly _tag: "Invalid"; readonly detail: string}
	| {readonly _tag: "Unauthenticated"; readonly reason: string}
	| {readonly _tag: "OverrideInert"; readonly reason: string}
	| {readonly _tag: "Failed"; readonly reason: string};

export type RenderLeg = (request: SurfaceRenderRequest) => Effect.Effect<SurfaceRender>;

export interface RenderOptions {
	readonly pr: number;
	readonly out: string;
	readonly surfaces: readonly string[];
	/** Raw `--flag` operands, each a `<key>=<on|off>` pair. Empty ⇒ every flag at its default. */
	readonly flags: readonly string[];
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
		case "Unauthenticated":
			return `${VERB}: surface "${surface}" did not render signed in (${render.reason}) — the authenticated render is UNKNOWN, never the anonymous one.`;
		case "OverrideInert":
			return `${VERB}: surface "${surface}" did not render with its forced flags (${render.reason}) — the forced render is UNKNOWN, never the default one.`;
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

		const operands = parseFlagOperands(options.flags);
		if (operands._tag === "Malformed") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --flag "${operands.token}" is not a <key>=<${FORCED_VALUES.join("|")}> pair (${operands.reason}) — an operand nothing can force would shoot the default state under the forced name.`,
			);
		}
		const forcedFlags = operands.flags;
		// The override rides the `phoenix_flag_overrides` cookie, which a deployed stage honors only
		// for a request whose actor holds platform Admin (`flagship/override-authz.ts`, untouched).
		// So an anonymous surface cannot carry a forced flag at all — it would render the default
		// state cleanly under the forced name, which is the coverage-claimed-and-not-held class this
		// verb already refuses a stateless `:state` for (#7051, #7218).
		if (isForcing(forcedFlags)) {
			const anonymous = options.surfaces.find((surface) => !provesSession(stateOf(surface)));
			if (anonymous !== undefined) {
				return refuse(
					OFF_VOCABULARY,
					`${VERB}: --flag was passed with the anonymous surface "${anonymous}" — the preview honors an override only for an authorized platform-admin actor, so an anonymous surface would render the default state silently; name every surface :auth.`,
				);
			}
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
		// so an incomplete pair is UNKNOWN here, before a browser launches.
		const wantsAuth = options.surfaces.some((surface) => provesSession(stateOf(surface)));
		const identity = readIdentity(options.env);
		if (wantsAuth && identity._tag === "Missing") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: an :auth surface was requested but its credentials are incomplete (unset: ${identity.names.join(", ")}) — the authenticated render is UNKNOWN, never the anonymous one.`,
				[scanned],
			);
		}
		const authCookies: readonly CaptureCookie[] =
			identity._tag === "Identity"
				? sessionCookies(announced.url, identity.token, identity.secret)
				: [];
		const forcedCookies = overrideCookies(announced.url, forcedFlags);

		const setDir = setDirectory(options.tmpRoot, pr, head, options.out);
		const renders: SurfaceRender[] = [];
		for (const surface of options.surfaces) {
			// Only the `:auth` variant carries the session and the override; a bare route stays the
			// visitor's render at every flag's default, so the two are genuinely different pixels
			// rather than one shot twice.
			const authenticated = provesSession(stateOf(surface));
			renders.push(
				yield* options.render({
					surface,
					previewUrl: announced.url,
					outDir: setDir,
					cookies: authenticated ? [...authCookies, ...forcedCookies] : [],
					forcedFlags: authenticated ? forcedFlags : NO_FORCED_FLAGS,
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
		// Ahead of the proven-red codes below, and deliberately: the shot is a fine PNG of the wrong
		// page, so routing it as a red surface would accuse the PR of a defect the render never saw.
		// The two arms are one class — wrong session, wrong flag state — and route alike.
		const wrongPage = renders.findIndex(
			(render) => render._tag === "Unauthenticated" || render._tag === "OverrideInert",
		);
		if (wrongPage !== -1) {
			return refuse(
				PRECONDITION_UNKNOWN,
				outcomeLine(options.surfaces[wrongPage] as string, renders[wrongPage] as SurfaceRender),
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
		const provenance = mintPreviewProvenance({
			repository: repo,
			pr,
			head,
			app: announced.app,
			previewUrl: announced.url,
			manifestSha256: sha256Hex(new TextEncoder().encode(document)),
		});
		const receipt = JSON.stringify(provenance.receipt);
		// A set without the manifest, signed receipt, and out-of-set key is not a set: `post` requires
		// this producer capability before it reads route-shaped bytes as preview evidence.
		const written = yield* Effect.result(
			Effect.all(
				[
					writeFile(manifestPath(setDir), document),
					writeFile(`${setDir}/${PREVIEW_PROVENANCE_RECEIPT}`, receipt),
					writeFile(
						previewProvenanceKeyPath(options.tmpRoot, provenance.receipt.keyId),
						provenance.key,
					),
				],
				{concurrency: 3},
			),
		);
		if (Result.isFailure(written)) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot write the set manifest and preview provenance for #${pr}: ${written.failure.reason} — the captures exist but the set does not.`,
				enumerated,
			);
		}
		return answer(document, enumerated);
	});
