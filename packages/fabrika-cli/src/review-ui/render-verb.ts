/**
 * Captures named views at the inspected preview head. The injected RenderLeg keeps refusals
 * testable without a browser. See ./command.ts help for inputs, results and refusal codes.
 *
 * Valid PNG bytes alone cannot prove the requested page: a wrong account tier, ignored flag
 * override or wrong viewport can all produce a valid image. Each needs its own proof.
 * A foreign app can return a valid not-found PNG at this preview origin.
 * A placeholder signing key can return visitor pixels despite a well-formed cookie.
 * @ruling https://github.com/kamp-us/phoenix/issues/8796
 * @ruling https://github.com/kamp-us/phoenix/issues/9288#issuecomment-5703250637
 * @ruling https://github.com/kamp-us/phoenix/issues/9533#issuecomment-5754589033
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	AUTH_SECRET_ENV,
	type AuthSecretRead,
	classifyAuthSecret,
	type IdentityRead,
	PREVIEW_AUTH_KEY_PATH,
	readIdentity,
	sessionCookies,
} from "../capture/auth.ts";
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
	routeOf,
	stateOf,
	tierOf,
} from "../capture/states.ts";
import {previewAppOf, type UiSurface} from "../config/keys/ui-surfaces.ts";
import {discoverRepoRoot} from "../delegate/root.ts";
import {readFile, writeFile} from "../io/fs.ts";
import {listComments} from "../io/issues.ts";
import {openPull, resolveTargetRepo, scannedLine} from "../review/target.ts";
import {appForSurface} from "../ui/surfaces.ts";
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
	/**
	 * The repo's declared `uiSurfaces` rows, read off the checkout this verb runs in — what says
	 * which app owns each `--surface`. An empty list answers that for no surface, so it fences none.
	 */
	readonly surfaceRows: ReadonlyArray<UiSurface>;
	/**
	 * A file holding a signing secret to use instead of the repo's own. `null` — the ordinary run —
	 * resolves the committed preview key at {@link PREVIEW_AUTH_KEY_PATH}, which is what the
	 * preview worker deploys with, and falls back to the ambient variable only in a checkout that
	 * carries no such file.
	 */
	readonly authSecretFrom: string | null;
	/** Where the run stands, so the committed preview key resolves against this checkout's root. */
	readonly cwd: string;
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
 * A failed capture cannot be dropped to make the set pass. Only the caller can choose a smaller
 * set on a later invocation. See ./command.ts help for the refusal codes.
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
			return `${VERB}: ${subject} is unreachable at the preview (${render.reason}) — judge what renders, and hold the gap against the PR's Deviations.`;
		case "Crashed":
			return `${VERB}: ${subject} threw during render: ${render.firstError} — the render is red; a broken page is not composition to judge.`;
		case "Invalid":
			return `${VERB}: ${subject} captured invalid bytes (${render.detail}) — a capture nobody can open is not evidence.`;
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

/** A named export that could not be opened at all — never folded into "the secret is empty". */
type UnreadableSecret = {
	readonly _tag: "Unreadable";
	readonly path: string;
	readonly reason: string;
};

/**
 * The run's signing key. Three sources, in this order, and the order is the whole design.
 *
 * `--auth-secret-from` comes first because it is the operator overriding on purpose; a run that
 * passed it and silently got something else would be a tool that did not listen.
 *
 * With no flag the source is the repo's own committed preview key — every `pr-<n>` preview worker
 * deploys with it, it is public on purpose, and it is the reason a seat needs no credential to
 * render an `:auth` surface at all. This verb only ever shoots a PR's preview, so that
 * is always the right key for the origin it is shooting.
 *
 * The ambient variable is last and is now a fallback rather than a route: it stands in only where
 * the checkout carries no committed key, which is a checkout predating that file. {@link
 * classifyAuthSecret} keeps it honest — a placeholder or empty value refuses rather than signing.
 *
 * A root discovery that *failed* is not that fallback's case. It refuses instead, because
 * {@link discoverRepoRoot} answers "no repo here" with `undefined` and "I could not look" on its `E`
 * channel, and an unreadable ancestor handed to the ambient arm would report the second as the first.
 *
 * A run whose surfaces name no tier asks for no session, so nothing calls this: there is no key to
 * read and no cookie to sign.
 */
const resolveAuthSecret = (
	options: RenderOptions,
): Effect.Effect<AuthSecretRead | UnreadableSecret, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const named = options.authSecretFrom;
		if (named !== null) {
			const read = yield* Effect.result(readFile(named));
			return Result.isFailure(read)
				? ({_tag: "Unreadable", path: named, reason: read.failure.reason} as const)
				: classifyAuthSecret(read.success, {_tag: "RepoWideExport", path: named});
		}
		const root = yield* Effect.result(discoverRepoRoot(options.cwd));
		// `discoverRepoRoot` keeps "I could not look" on its `E` channel and "there is no repo here"
		// on `undefined`, so folding the failure into the ambient fallback would report an unreadable
		// ancestor as a checkout that simply carries no committed key.
		if (Result.isFailure(root)) {
			return {
				_tag: "Unreadable",
				path: root.failure.path,
				reason: `${root.failure.reason} — the repo root could not be located, so the committed preview key was never looked for`,
			} as const;
		}
		if (root.success !== undefined) {
			const path = (yield* Path.Path).join(root.success, PREVIEW_AUTH_KEY_PATH);
			const committed = yield* Effect.result(readFile(path));
			if (!Result.isFailure(committed)) {
				return classifyAuthSecret(committed.success, {_tag: "CommittedPreviewKey", path});
			}
		}
		return classifyAuthSecret(options.env[AUTH_SECRET_ENV] ?? "", {
			_tag: "Ambient",
			name: AUTH_SECRET_ENV,
		});
	});

/**
 * The credentials a tier-naming run needs, or the one thing that stopped the read: an export that
 * could not be opened, a key that must not be signed with, or an unset session token. Only a run
 * that names a tier calls this, so every arm here is about a session a surface actually asked for.
 */
const resolveTierIdentity = (
	options: RenderOptions,
	tiers: readonly CaptureTier[],
): Effect.Effect<IdentityRead | UnreadableSecret, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const secret = yield* resolveAuthSecret(options);
		return secret._tag === "Unreadable" ? secret : readIdentity(options.env, tiers, secret);
	});

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
				`${VERB}: no --surface operands — "rendered nothing, found nothing wrong" is not an answer.`,
			);
		}
		if (!isKebabSetName(options.out)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --out "${options.out}" is not a kebab-case set name.`,
			);
		}
		// A state is admitted only when something puts it on screen. Parsing one and shooting the
		// default pixels under a variant's name is coverage claimed and not held.
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
		// for implicitly.
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
		// verb already refuses a stateless `:state` for.
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
		// old tree with a new head — the stale-verdict class at the capture seam.
		if (!prefixMatch(head, announced.deployedSha)) {
			return refuse(
				STALE_TREE,
				`${VERB}: the preview deploys ${shortSha(announced.deployedSha)}, the live head is ${shortSha(head)} — stale preview; pixels of an old tree must not bind a new head.`,
				[scanned],
			);
		}

		// The app axis, fenced here the way the tier and flag axes are fenced above: every surface is
		// shot at the one origin this preview announced, so a surface whose own `uiSurfaces` row
		// belongs to an app the announcement never carried comes back as the announced app's
		// not-found page — a valid PNG the outcome typing below records as `captured`, which is the
		// one word a gate reads as coverage held. A surface no declared row claims is left to the
		// shot: which app serves it is a question this list does not answer either way.
		const foreign = options.surfaces.flatMap((surface) => {
			const row = appForSurface(options.surfaceRows, routeOf(surface));
			if (row === null) return [];
			const app = previewAppOf(row);
			return preview.apps.includes(app) ? [] : [{surface, row, app}];
		});
		const firstForeign = foreign[0];
		if (firstForeign !== undefined) {
			const foreignLine = (entry: (typeof foreign)[number]): string =>
				`${VERB}: --surface "${entry.surface}" is served by app "${entry.app}" (row "${entry.row.name}"), which this preview does not announce — it announces ${preview.apps.join(", ")}; the shot would come back as an announced app's not-found page.`;
			return refuse(PRECONDITION_UNKNOWN, foreignLine(firstForeign), [
				scanned,
				...foreign.map(foreignLine),
			]);
		}

		// A tier-naming surface rendered without that tier's credentials would come back as the
		// visitor's page — or worse, as the one tier this preview did seed — under the named tier's
		// name. That is the "unseen ground reading as clean" this whole axis exists to stop, so an
		// incomplete credential set is UNKNOWN here, before a browser launches. A tier whose token is
		// unset is a tier `preview-seed test-account` did not seed on this preview.
		const wantedTiers = options.surfaces.flatMap((surface) => {
			const tier = tierOf(stateOf(surface));
			return tier === null ? [] : [tier];
		});
		// The signing key is read before the tokens and refused on its own terms: it is the deployed
		// value, not the seat's, and a seat signing with `.env.example`'s placeholder produces a
		// well-formed cookie the worker answers as a visitor — indistinguishable at the shot from a
		// preview nobody seeded. An anonymous run reads no key at all: `null` here is "no surface
		// asked for a session", which is why no unsigned cookie can be built out of it below.
		const identity =
			wantedTiers.length === 0 ? null : yield* resolveTierIdentity(options, wantedTiers);
		if (identity?._tag === "Unreadable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the session-signing secret at ${identity.path}: ${identity.reason} — the named tier's render is UNKNOWN.`,
				[scanned],
			);
		}
		if (identity?._tag === "Unusable") {
			// The route out differs by source. Neither arm sends a seat after a credential any more:
			// the preview key is committed, so an unusable value is either a broken checkout or a flag
			// the operator passed over it — never a secret they have to go and be given.
			const route =
				options.authSecretFrom === null
					? ` run from a checkout carrying ${PREVIEW_AUTH_KEY_PATH}, the committed preview key every pr-<n> worker deploys with — no flag, no credential and no environment variable are needed for it.`
					: ` that file does not hold the value this preview verifies against; drop --auth-secret-from and the committed preview key at ${PREVIEW_AUTH_KEY_PATH} resolves on its own.`;
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: a tier-naming surface was requested but ${identity.reason} — the named tier's render is UNKNOWN, never a cookie the worker will reject;${route}`,
				[scanned],
			);
		}
		if (identity?._tag === "Missing") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: a tier-naming surface was requested but its credentials are incomplete (unset: ${identity.names.join(", ")}) — the named tier's render is UNKNOWN, never a seeded substitute.`,
				[scanned],
			);
		}
		const cookiesFor = (tier: CaptureTier): readonly CaptureCookie[] => {
			if (identity === null || identity._tag !== "Identity") return [];
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
