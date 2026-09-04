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
 * which is coverage claimed and not held (#7051). Every realized state names the **tier** it renders
 * at, and a tier-naming surface is refused three times over, all on `11`: before a browser launches
 * when that tier's credentials are incomplete — an unset tier token is a tier `preview-seed
 * test-account` did not seed, and falling back to the seeded one would shoot the wrong audience
 * clean (#7398); when the shot's own session proof does not come back signed in; and when that proof
 * comes back at a different tier than the surface named. Each produces a perfectly valid PNG of a
 * page nobody asked for, which no byte check can tell from the real thing.
 *
 * `--viewport <name>` picks the widths the surfaces are shot at, over `plan.ts`'s closed set, and
 * defaults to `desktop` alone so every caller written before it is unchanged (#7706). Viewports
 * cross the surfaces: two of each is four captures in one set, distinguished on disk and in the
 * manifest by the viewport label. Each shot then proves its own width off the PNG header — the
 * narrow half of the design law is only answerable from narrow pixels, and a desktop-width shot
 * filed under `mobile` would answer it from the wrong ones, on `19`.
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
import {DEFAULT_VIEWPORT, VIEWPORT_NAMES, type Viewport, viewportOf} from "../capture/plan.ts";
import {
	type CaptureTier,
	isRealizedState,
	provesSession,
	REALIZED_STATES,
	stateOf,
	tierOf,
} from "../capture/states.ts";
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
	WRONG_VIEWPORT,
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
	/** The width this shot is asked for, and the width its bytes must read back at. */
	readonly viewport: Viewport;
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
	| {readonly _tag: "WrongTier"; readonly wanted: CaptureTier; readonly rendered: string}
	| {readonly _tag: "WrongViewport"; readonly wanted: number; readonly rendered: number}
	| {readonly _tag: "OverrideInert"; readonly reason: string}
	| {readonly _tag: "Failed"; readonly reason: string};

export type RenderLeg = (request: SurfaceRenderRequest) => Effect.Effect<SurfaceRender>;

export interface RenderOptions {
	readonly pr: number;
	readonly out: string;
	readonly surfaces: readonly string[];
	/** Raw `--viewport` operands, each a name in `plan.ts`'s closed set. Empty ⇒ desktop alone. */
	readonly viewports: readonly string[];
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

/**
 * One planned shot: a surface at a viewport. The set is the cross product of the two operand lists,
 * so nothing downstream can name a surface without the width its pixels are of.
 */
interface PlannedShot {
	readonly surface: string;
	readonly viewport: Viewport;
}

/** Every enumeration and every refusal names the shot, and a shot is a surface at a viewport. */
const shotName = (shot: PlannedShot): string =>
	`surface "${shot.surface}" at ${shot.viewport.label}`;

const outcomeLine = (shot: PlannedShot, render: SurfaceRender): string => {
	const subject = shotName(shot);
	switch (render._tag) {
		case "Rendered": {
			// The count is the whole tally, not the kept rows: the payload collapses the list, so a
			// stderr count read off `rows` alone would under-report exactly when there is most to report.
			const errors = render.entry.pageErrors;
			return `${VERB}: ${subject} captured: ${render.entry.width}x${render.entry.height}, ${errors.rows.length + errors.more} page error(s)`;
		}
		case "Unreachable":
			return `${VERB}: ${subject} is unreachable at the preview (${render.reason}) — judge what renders, and hold the gap against the PR's Deviations (#4305).`;
		case "Crashed":
			return `${VERB}: ${subject} threw during render: ${render.firstError} — the render is red; a broken page is not composition to judge.`;
		case "Invalid":
			return `${VERB}: ${subject} captured invalid bytes (${render.detail}) — a capture nobody can open is not evidence (#3925's class).`;
		case "Unauthenticated":
			return `${VERB}: ${subject} did not render signed in (${render.reason}) — the authenticated render is UNKNOWN, never the anonymous one.`;
		case "WrongTier":
			return `${VERB}: ${subject} named tier ${render.wanted} and rendered as ${render.rendered} — the named tier's render is UNKNOWN, never another tier's.`;
		case "WrongViewport":
			return `${VERB}: ${subject} was asked for at ${render.wanted}px and its bytes read back ${render.rendered}px wide — the requested viewport's render is UNKNOWN, never another width's.`;
		case "OverrideInert":
			return `${VERB}: ${subject} did not render with its forced flags (${render.reason}) — the forced render is UNKNOWN, never the default one.`;
		case "Failed":
			return `${VERB}: ${subject} could not be rendered: ${render.reason} — the outcome is UNKNOWN.`;
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

		const unknownViewport = options.viewports.find((name) => viewportOf(name) === null);
		if (unknownViewport !== undefined) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --viewport "${unknownViewport}" is not a viewport this repo renders — the names are ${VIEWPORT_NAMES.join(", ")}.`,
			);
		}
		const repeated = options.viewports.find(
			(name, index) => options.viewports.indexOf(name) !== index,
		);
		if (repeated !== undefined) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --viewport "${repeated}" was passed twice — the second shot would overwrite the first's file and evidence.`,
			);
		}
		// Omitted is desktop alone, which is what every invocation written before this operand asked
		// for implicitly (#7706).
		const viewports: readonly Viewport[] =
			options.viewports.length === 0
				? [DEFAULT_VIEWPORT]
				: options.viewports.map((name) => viewportOf(name) as Viewport);

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
					`${VERB}: --flag was passed with the anonymous surface "${anonymous}" — the preview honors an override only for an authorized platform-admin actor, so an anonymous surface would render the default state silently; name a tier state (${REALIZED_STATES.join(", ")}) on every surface.`,
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

		// A tier-naming surface rendered without that tier's credentials would come back as the
		// visitor's page — or worse, as the one tier this preview did seed — under the named tier's
		// name. That is the "unseen ground reading as clean" this whole axis exists to stop, so an
		// incomplete credential set is UNKNOWN here, before a browser launches. A tier whose token is
		// unset is a tier `preview-seed test-account` did not seed on this preview (#7398).
		const wantedTiers = options.surfaces.flatMap((surface) => {
			const tier = tierOf(stateOf(surface));
			return tier === null ? [] : [tier];
		});
		const identity = readIdentity(options.env, wantedTiers);
		if (wantedTiers.length > 0 && identity._tag === "Missing") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: a tier-naming surface was requested but its credentials are incomplete (unset: ${identity.names.join(", ")}) — the named tier's render is UNKNOWN, never a seeded substitute.`,
				[scanned],
			);
		}
		const cookiesFor = (tier: CaptureTier): readonly CaptureCookie[] => {
			if (identity._tag !== "Identity") return [];
			const token = identity.tokens[tier];
			return token === undefined ? [] : sessionCookies(announced.url, token, identity.secret);
		};
		const forcedCookies = overrideCookies(announced.url, forcedFlags);

		const setDir = setDirectory(options.tmpRoot, pr, head, options.out);
		// Surface-major so a mixed-viewport enumeration reads one surface's widths together.
		const shots: readonly PlannedShot[] = options.surfaces.flatMap((surface) =>
			viewports.map((viewport) => ({surface, viewport})),
		);
		const renders: SurfaceRender[] = [];
		for (const shot of shots) {
			// Only a tier-naming variant carries a session and the override, and it carries ITS OWN
			// tier's session: a bare route stays the visitor's render at every flag's default, so each
			// is genuinely different pixels rather than one shot repeated.
			const tier = tierOf(stateOf(shot.surface));
			renders.push(
				yield* options.render({
					surface: shot.surface,
					viewport: shot.viewport,
					previewUrl: announced.url,
					outDir: setDir,
					cookies: tier === null ? [] : [...cookiesFor(tier), ...forcedCookies],
					forcedFlags: tier === null ? NO_FORCED_FLAGS : forcedFlags,
				}),
			);
		}
		const enumerated = [
			scanned,
			...shots.map((shot, i) => outcomeLine(shot, renders[i] as SurfaceRender)),
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
		// The three arms are one class — wrong session, wrong tier, wrong flag state — and route alike.
		const wrongPage = renders.findIndex(
			(render) =>
				render._tag === "Unauthenticated" ||
				render._tag === "WrongTier" ||
				render._tag === "OverrideInert",
		);
		if (wrongPage !== -1) {
			return refuse(
				PRECONDITION_UNKNOWN,
				outcomeLine(shots[wrongPage] as PlannedShot, renders[wrongPage] as SurfaceRender),
				enumerated,
			);
		}
		// Its own code rather than the `11` above, because this one is proven against the recorded
		// bytes rather than against a probe the preview answered.
		const wrongWidth = renders.findIndex((render) => render._tag === "WrongViewport");
		if (wrongWidth !== -1) {
			return refuse(
				WRONG_VIEWPORT,
				outcomeLine(shots[wrongWidth] as PlannedShot, renders[wrongWidth] as SurfaceRender),
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
				outcomeLine(shots[index] as PlannedShot, renders[index] as SurfaceRender),
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
