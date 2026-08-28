/**
 * `ui render` — render the named surfaces in this tree and capture one **validated** PNG each.
 *
 * Two properties carry the whole verb. First, scope is exactly the `--surface` operands: nothing here
 * scans a diff, so "rendered nothing, found nothing wrong" is unrepresentable (ADR 0092), and a
 * dropped surface is the skill's explicit act — re-invoking without it — never the tool's silent
 * tolerance (#4305 / #3232). Second, validity is part of the answer: a capture that is zero bytes,
 * undecodable or zero-area is `16`, because a capture nobody can open is not evidence (#3925's class)
 * and v1 checked capture success nowhere at all.
 *
 * The set manifest is the seam to `ui evidence`: `<set>/manifest.json` holds the exact stdout bytes,
 * so no value crosses that seam by memory.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {requireSession} from "../build/claim.ts";
import {isKebabSlug} from "../build/lane.ts";
import {laneScratchDir} from "../build/scratch-verb.ts";
import {resolveTargetRepo} from "../build/target.ts";
import {designHarnessOr} from "../config/paths.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {readBytes, writeText} from "./bytes.ts";
import {
	BAD_SECTIONS,
	CAPTURE_INVALID,
	NO_HARNESS,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	RENDER_CRASHED,
	SURFACE_UNREACHABLE,
} from "./codes.ts";
import {atRoot} from "./conventions.ts";
import {type HarnessConfig, parseHarness, surfaceSlug} from "./harness.ts";
import {requireUiLane} from "./lane.ts";
import {probe} from "./manifest-verb.ts";
import {decodePng, sha256Of} from "./png.ts";

const VERB = "ui render";

/** One shot's proven outcome — the four the exit matrix routes on, decided by the impure leg. */
export type ShotOutcome =
	| {readonly _tag: "Captured"}
	| {readonly _tag: "Unreachable"; readonly reason: string}
	| {readonly _tag: "Crashed"; readonly error: string}
	| {readonly _tag: "Unknown"; readonly reason: string};

export interface ShotRequest {
	readonly url: string;
	readonly outPath: string;
	readonly viewport: {readonly width: number; readonly height: number};
	/** Absolute path to a Playwright storage-state file, or `null` to browse signed out. */
	readonly storageState: string | null;
}

/** The injected browser leg: navigate, classify, screenshot to `outPath`. */
export type BrowseLeg = (request: ShotRequest) => Effect.Effect<ShotOutcome>;

export type HarnessStart =
	| {readonly _tag: "Ready"; readonly stop: Effect.Effect<void>}
	| {readonly _tag: "Failed"; readonly reason: string}
	| {readonly _tag: "NotReady"; readonly tail: string};

/** The injected dev-server leg: start the repo's own command, poll readiness, hand back a killer. */
export type HarnessLeg = (config: HarnessConfig, root: string) => Effect.Effect<HarnessStart>;

export interface RenderOptions {
	readonly out: string;
	readonly surfaces: ReadonlyArray<string>;
	readonly firstRender: ReadonlyArray<string>;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly tmpRoot: string;
	readonly startHarness: HarnessLeg;
	readonly browse: BrowseLeg;
}

interface Capture {
	readonly surface: string;
	readonly path: string;
	readonly width: number;
	readonly height: number;
	readonly sha256: string;
	readonly firstRender: boolean;
}

type SurfaceResult =
	| {readonly _tag: "Ok"; readonly capture: Capture}
	| {readonly _tag: "Bad"; readonly code: number; readonly line: string};

/** A usage/vocabulary refusal on the operands, or `null` when they are well formed. */
export const checkOperands = (options: RenderOptions): VerbOutcome | null => {
	if (options.surfaces.length === 0) {
		return refuse(
			FAILED,
			`${VERB}: --surface is required at least once — no tool guesses surfaces from a diff.`,
		);
	}
	if (!isKebabSlug(options.out) || options.out.includes("/")) {
		return refuse(OFF_VOCABULARY, `${VERB}: --out "${options.out}" is not a kebab-case set name.`);
	}
	for (const surface of options.surfaces) {
		if (surface.includes(":")) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --surface "${surface}" carries a :state suffix — states are a reserved grammar, not yet realized; render the bare route.`,
			);
		}
		if (!surface.startsWith("/")) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --surface "${surface}" is not a bare route — a surface id begins with "/".`,
			);
		}
	}
	for (const first of options.firstRender) {
		if (!options.surfaces.includes(first)) {
			return refuse(
				FAILED,
				`${VERB}: --first-render "${first}" names a surface that is not being rendered.`,
			);
		}
	}
	return null;
};

const shoot = (
	options: RenderOptions,
	config: HarnessConfig,
	root: string,
	setDir: string,
	surface: string,
): Effect.Effect<SurfaceResult, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const outPath = `${setDir}/${surfaceSlug(surface)}.png`;
		const shot = yield* options.browse({
			url: `${config.url}${surface}`,
			outPath,
			viewport: config.viewport,
			storageState: config.storageState === null ? null : atRoot(root, config.storageState),
		});
		if (shot._tag === "Unreachable") {
			return {
				_tag: "Bad" as const,
				code: SURFACE_UNREACHABLE,
				line: `${VERB}: surface "${surface}" is unreachable in this tree (${shot.reason}) — fix reachability, or drop it explicitly and carry the reason into the PR's Deviations (#4305).`,
			};
		}
		if (shot._tag === "Crashed") {
			return {
				_tag: "Bad" as const,
				code: RENDER_CRASHED,
				line: `${VERB}: surface "${surface}" threw during render: ${shot.error} — the render is red; fix it before looking.`,
			};
		}
		if (shot._tag === "Unknown") {
			return {
				_tag: "Bad" as const,
				code: PRECONDITION_UNKNOWN,
				line: `${VERB}: cannot determine the validity of ${outPath}: ${shot.reason} — the capture is UNKNOWN, never valid.`,
			};
		}
		const bytes = yield* readBytes(outPath);
		if (bytes._tag === "Failed") {
			return {
				_tag: "Bad" as const,
				code: PRECONDITION_UNKNOWN,
				line: `${VERB}: cannot determine the validity of ${outPath}: ${bytes.reason} — the capture is UNKNOWN, never valid.`,
			};
		}
		const image = decodePng(bytes.bytes);
		if (image._tag === "Invalid") {
			return {
				_tag: "Bad" as const,
				code: CAPTURE_INVALID,
				line: `${VERB}: surface "${surface}" captured invalid bytes (${image.detail}) — a capture nobody can open is not evidence (#3925's class).`,
			};
		}
		return {
			_tag: "Ok" as const,
			capture: {
				surface,
				path: outPath,
				width: image.image.width,
				height: image.image.height,
				sha256: sha256Of(bytes.bytes),
				firstRender: options.firstRender.includes(surface),
			},
		};
	});

export const runRender = (
	options: RenderOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const bad = checkOperands(options);
		if (bad !== null) return bad;

		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const lane = yield* requireUiLane(
			VERB,
			resolved.repo,
			session.id,
			(detail: string) =>
				`${VERB}: this session does not hold the claim the checked-out branch names (${detail}) — the lane is not yours.`,
		);
		if (lane._tag === "Refused") return lane.outcome;

		const declared = yield* designHarnessOr(
			VERB,
			lane.root,
			"where this repo declares its render path is unread — the render path is UNKNOWN, never absent.",
		);
		if (declared._tag === "Refused") {
			return refuse(PRECONDITION_UNKNOWN, declared.message, lane.notes);
		}
		const harnessPath = declared.path;

		const harnessProbe = yield* probe(lane.root, harnessPath);
		if (harnessProbe._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot probe ${harnessPath}: ${harnessProbe.reason} — the render path is UNKNOWN.`,
				lane.notes,
			);
		}
		if (harnessProbe._tag === "Absent") {
			return refuse(
				NO_HARNESS,
				`${VERB}: no ${harnessPath} at the repo root — this repo declares no headless render path; add one (see the harness config schema).`,
				lane.notes,
			);
		}
		const raw = yield* readBytes(atRoot(lane.root, harnessPath));
		if (raw._tag === "Failed") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${harnessPath}: ${raw.reason} — the render path is UNKNOWN.`,
				lane.notes,
			);
		}
		const harness = parseHarness(new TextDecoder().decode(raw.bytes));
		if (harness._tag === "Violation") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: ${harnessPath} exists but does not satisfy its schema: ${harness.violation}.`,
				lane.notes,
			);
		}

		if (harness.config.storageState !== null) {
			const sessionProbe = yield* probe(lane.root, harness.config.storageState);
			if (sessionProbe._tag === "Unknown") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot probe ${harness.config.storageState}: ${sessionProbe.reason} — the render path is UNKNOWN.`,
					lane.notes,
				);
			}
			if (sessionProbe._tag === "Absent") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: ${harnessPath} declares storageState ${harness.config.storageState}, and no file is there — every surface behind a login would capture the login page. Re-authenticate and write the file, or drop the key.`,
					lane.notes,
				);
			}
		}

		const setDir = `${laneScratchDir(options.tmpRoot, session.id, lane.number, lane.nonce)}/${options.out}`;
		const started = yield* options.startHarness(harness.config, lane.root);
		if (started._tag === "Failed") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: the render harness could not start: ${started.reason} — every surface is UNKNOWN.`,
				lane.notes,
			);
		}
		if (started._tag === "NotReady") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: the harness did not answer 200 on ${harness.config.readyPath} within the readiness bound — every surface is UNKNOWN; server stderr tail: ${started.tail}.`,
				lane.notes,
			);
		}

		const results = yield* Effect.forEach(
			options.surfaces,
			(surface) => shoot(options, harness.config, lane.root, setDir, surface),
			{concurrency: 1},
		).pipe(Effect.ensuring(started.stop));

		const notes = [
			...lane.notes,
			`${VERB}: rendered ${options.surfaces.length} surface${options.surfaces.length === 1 ? "" : "s"} into ${setDir}.`,
			...results.flatMap((result) => (result._tag === "Bad" ? [result.line] : [])),
		];
		const failed = results.filter((result) => result._tag === "Bad");
		const firstFailure = failed[0];
		if (firstFailure !== undefined) {
			// The code routes and the stderr enumerates: with mixed outcomes the SMALLEST applicable
			// code is reported, and every surface's own outcome is already on stderr above.
			const code = Math.min(...failed.map((result) => result.code));
			return refuse(
				code,
				`${VERB}: ${failed.length} of ${options.surfaces.length} surfaces did not produce a valid capture — the set is refused whole.`,
				notes,
			);
		}

		const captures = results.flatMap((result) => (result._tag === "Ok" ? [result.capture] : []));
		const stdout = `${JSON.stringify({set: options.out, captures})}\n`;
		const failure = yield* writeText(`${setDir}/manifest.json`, stdout);
		return failure === null
			? answer(stdout, notes)
			: refuse(FAILED, `${VERB}: cannot write ${setDir}/manifest.json: ${failure}.`, notes);
	});
