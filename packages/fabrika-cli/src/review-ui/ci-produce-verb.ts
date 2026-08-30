import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve, sep} from "node:path";
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CapturedSurface, captureShots} from "../capture/capture.ts";
import type {Shot} from "../capture/plan.ts";
import {validateCaptureBytes} from "../capture/png.ts";
import {execRecord} from "../io/exec.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	INVALID_CAPTURE,
	MALFORMED_DOCUMENT,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	RENDER_CRASHED,
	STALE_TREE,
} from "./codes.ts";
import {
	type CiCaptureManifest,
	declarationDigest,
	LOCALHOST_DECLARATIONS_PATH,
	parseLocalhostDeclarations,
} from "./localhost-evidence.ts";
import {PAGE_ERROR_CAP, sha256Hex} from "./manifest.ts";

const VERB = "review-ui ci-produce";
const FULL_SHA = /^[0-9a-f]{40}$/;
const SUBJECT_DOCKERFILE = ".github/review-ui-localhost-subject.Dockerfile";

export const isolatedEnvironment = (
	env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
	const isolated: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (
			value === undefined ||
			key.startsWith("GITHUB_") ||
			key.startsWith("ACTIONS_") ||
			/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)/.test(key)
		) {
			continue;
		}
		isolated[key] = value;
	}
	return isolated;
};

export interface CiProduceOptions {
	readonly pr: number;
	readonly head: string;
	readonly harness: string;
	readonly runId: number;
	readonly repository: string;
	readonly subjectRoot: string;
	readonly authorityRoot: string;
	readonly outputDir: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).trim();

const isInside = (parent: string, candidate: string): boolean => {
	const root = resolve(parent);
	const path = resolve(candidate);
	return path === root || path.startsWith(`${root}${sep}`);
};

const containerGuardArgs = (): readonly string[] => [
	"--read-only",
	"--cap-drop",
	"ALL",
	"--security-opt",
	"no-new-privileges",
	"--tmpfs",
	"/tmp:rw,nosuid,nodev,size=64m",
];

export const subjectTestContainerArgs = (
	image: string,
	command: readonly string[],
): readonly string[] => [
	"run",
	"--rm",
	"--network",
	"none",
	...containerGuardArgs(),
	image,
	...command,
];

export const subjectServerContainerArgs = (
	image: string,
	name: string,
	fixtureRoot: string,
	containerPort: number,
	command: readonly string[],
): readonly string[] => [
	"run",
	"--detach",
	"--rm",
	"--name",
	name,
	...containerGuardArgs(),
	"--mount",
	`type=bind,src=${fixtureRoot},dst=/review-ui-fixture,readonly`,
	"--env",
	"TUVAL_SESSION_ROOT=/review-ui-fixture/sessions",
	"--publish",
	`127.0.0.1::${containerPort}`,
	image,
	...command,
];

const ran = (
	file: string,
	args: readonly string[],
	cwd: string,
	env: Readonly<Record<string, string>>,
	timeoutSeconds: number,
) =>
	execRecord({
		file,
		args,
		cwd,
		env,
		timeoutSeconds,
		captureBytes: 1_048_576,
	});

const createFixture = (): Promise<string> =>
	mkdtemp(join(tmpdir(), "fabrika-review-ui-localhost-")).then(async (root) => {
		const sessions = join(root, "sessions");
		await mkdir(sessions, {recursive: true});
		await writeFile(
			join(sessions, "2026-08-29T10-00-00-000Z_review-ui.jsonl"),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "review-ui",
				timestamp: "2026-08-29T10:00:00.000Z",
				cwd: "/work/review-ui",
			})}\n`,
		);
		return root;
	});

const captureLocalhost = (
	url: string,
	outputDir: string,
	captureReadySelector: string,
	surfaces: ReadonlyArray<{
		readonly id: string;
		readonly route: string;
		readonly state: string;
		readonly width: number;
		readonly height: number;
	}>,
): Effect.Effect<readonly CapturedSurface[], string> => {
	const shots: Shot[] = surfaces.map((surface) => ({
		surface: {surface: surface.id, route: surface.route, state: surface.state},
		url: new URL(surface.route, url).toString(),
		viewport: {label: surface.state, width: surface.width, height: surface.height},
		fileName: `${surface.id}.png`,
	}));
	return captureShots(shots, join(outputDir, "captures"), {
		fullPage: true,
		waitUntil: "load",
		readySelector: captureReadySelector,
	}).pipe(Effect.mapError((cause) => cause.message));
};

export const runCiProduce = (
	options: CiProduceOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (!FULL_SHA.test(options.head)) {
			return refuse(OFF_VOCABULARY, `${VERB}: --head must be one full lowercase 40-character SHA.`);
		}
		if (!Number.isInteger(options.runId) || options.runId <= 0) {
			return refuse(OFF_VOCABULARY, `${VERB}: --run-id must be a positive Actions run id.`);
		}
		if (!/^[^/\s]+\/[^/\s]+$/.test(options.repository)) {
			return refuse(OFF_VOCABULARY, `${VERB}: --repository must be one owner/name.`);
		}

		const authorityRead = yield* Effect.tryPromise({
			try: () => readFile(join(options.authorityRoot, LOCALHOST_DECLARATIONS_PATH), "utf8"),
			catch: (cause) => String(cause),
		}).pipe(Effect.result);
		if (authorityRead._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the governed declaration: ${authorityRead.failure}.`,
			);
		}
		const declarationText = authorityRead.success;
		const declarations = parseLocalhostDeclarations(declarationText);
		if (declarations._tag === "Malformed") {
			return refuse(
				MALFORMED_DOCUMENT,
				`${VERB}: the governed declaration is malformed (${declarations.reason}).`,
			);
		}
		const harness = declarations.value.harnesses.find((entry) => entry.id === options.harness);
		if (harness === undefined) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: "${options.harness}" is not a governed localhost harness.`,
			);
		}

		const env = isolatedEnvironment(options.env);
		const checkedOut = yield* ran("git", ["rev-parse", "HEAD"], options.subjectRoot, env, 30);
		const checkedOutHead =
			checkedOut._tag === "Ran" && checkedOut.exitCode === 0 ? decode(checkedOut.stdout) : "";
		if (checkedOutHead !== options.head) {
			return refuse(
				STALE_TREE,
				`${VERB}: the subject checkout is ${checkedOutHead || "unreadable"}, not ${options.head}.`,
			);
		}

		if (
			isInside(options.subjectRoot, options.outputDir) ||
			isInside(options.authorityRoot, options.outputDir)
		) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --output-dir must be outside both the subject and authority checkouts.`,
			);
		}

		const image = `fabrika-review-ui-subject-${options.runId}`;
		const container = `${image}-server`;
		const fixtureRead = yield* Effect.tryPromise({
			try: createFixture,
			catch: (cause) => String(cause),
		}).pipe(Effect.result);
		if (fixtureRead._tag === "Failure") {
			return refuse(PRECONDITION_UNKNOWN, `${VERB}: cannot create the trusted fixture.`);
		}
		const fixtureRoot = fixtureRead.success;
		const cleanup = Effect.gen(function* () {
			yield* ran("docker", ["rm", "--force", container], options.authorityRoot, env, 30).pipe(
				Effect.ignore,
			);
			yield* ran("docker", ["image", "rm", "--force", image], options.authorityRoot, env, 60).pipe(
				Effect.ignore,
			);
			yield* Effect.tryPromise({
				try: () => rm(fixtureRoot, {recursive: true, force: true}),
				catch: () => undefined,
			}).pipe(Effect.ignore);
		});

		return yield* Effect.gen(function* () {
			const cleared = yield* Effect.tryPromise({
				try: () => rm(options.outputDir, {recursive: true, force: true}),
				catch: (cause) => String(cause),
			}).pipe(Effect.result);
			if (cleared._tag === "Failure") {
				return refuse(PRECONDITION_UNKNOWN, `${VERB}: the trusted output cannot be cleared.`);
			}

			const built = yield* ran(
				"docker",
				[
					"build",
					"--file",
					join(options.authorityRoot, SUBJECT_DOCKERFILE),
					"--tag",
					image,
					options.subjectRoot,
				],
				options.authorityRoot,
				env,
				1_200,
			);
			if (built._tag !== "Ran" || built.exitCode !== 0 || built.timedOut || built.truncated) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: the isolated subject image could not be built (${built._tag === "Ran" ? decode(built.stderr) || `exit ${built.exitCode}` : built.reason}).`,
				);
			}

			const tested = yield* ran(
				"docker",
				subjectTestContainerArgs(image, harness.captureCommand),
				options.authorityRoot,
				env,
				1_200,
			);
			if (tested._tag !== "Ran" || tested.exitCode !== 0 || tested.timedOut || tested.truncated) {
				return refuse(
					RENDER_CRASHED,
					`${VERB}: the governed browser journey failed (${tested._tag === "Ran" ? decode(tested.stderr) || `exit ${tested.exitCode}` : tested.reason}).`,
				);
			}

			const started = yield* ran(
				"docker",
				subjectServerContainerArgs(
					image,
					container,
					fixtureRoot,
					harness.containerPort,
					harness.serverCommand,
				),
				options.authorityRoot,
				env,
				30,
			);
			if (started._tag !== "Ran" || started.exitCode !== 0) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: the isolated subject server could not start.`,
				);
			}
			const containerId = decode(started.stdout);
			if (containerId === "") {
				return refuse(PRECONDITION_UNKNOWN, `${VERB}: Docker returned no subject container id.`);
			}

			let ready = false;
			for (let attempt = 0; attempt < 80; attempt += 1) {
				const logs = yield* ran("docker", ["logs", containerId], options.authorityRoot, env, 10);
				if (
					logs._tag === "Ran" &&
					new RegExp(harness.readinessPattern).test(
						`${decode(logs.stdout)}\n${decode(logs.stderr)}`,
					)
				) {
					ready = true;
					break;
				}
				yield* Effect.sleep("250 millis");
			}
			if (!ready) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: the isolated subject server did not report readiness.`,
				);
			}
			const portRead = yield* ran(
				"docker",
				["port", containerId, `${harness.containerPort}/tcp`],
				options.authorityRoot,
				env,
				10,
			);
			const portMatch =
				portRead._tag === "Ran" && portRead.exitCode === 0
					? /127\.0\.0\.1:(\d+)/.exec(decode(portRead.stdout))
					: null;
			if (portMatch?.[1] === undefined) {
				return refuse(PRECONDITION_UNKNOWN, `${VERB}: the subject server port is unreadable.`);
			}

			const captures = yield* captureLocalhost(
				`http://127.0.0.1:${portMatch[1]}`,
				options.outputDir,
				harness.captureReadySelector,
				harness.surfaces,
			).pipe(Effect.result);
			if (captures._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: the trusted localhost capture failed (${captures.failure}).`,
				);
			}
			const uncaught = captures.success.flatMap((capture) =>
				capture.pageErrors.filter((error) => error.kind === "pageerror"),
			);
			if (uncaught.length > 0) {
				return refuse(
					RENDER_CRASHED,
					`${VERB}: ${uncaught.length} uncaught page error(s) made the render red.`,
				);
			}
			const validatedCaptures: Array<
				readonly [CapturedSurface, {readonly width: number; readonly height: number}]
			> = [];
			for (const capture of captures.success) {
				const valid = validateCaptureBytes(capture.pngBytes);
				if (valid._tag === "Invalid") {
					return refuse(
						INVALID_CAPTURE,
						`${VERB}: ${capture.surface} is not a valid capture (${valid.reason}).`,
					);
				}
				validatedCaptures.push([capture, {width: valid.width, height: valid.height}]);
			}
			const manifest: CiCaptureManifest = {
				schemaVersion: 1,
				source: "github-actions",
				repository: options.repository,
				pr: options.pr,
				head: options.head,
				harness: harness.id,
				declarationSha256: declarationDigest(declarationText),
				producer: {
					workflow: harness.workflow,
					check: harness.check,
					event: harness.event,
					runId: options.runId,
					artifact: harness.artifact,
				},
				captures: validatedCaptures.map(([capture, dimensions]) => ({
					surface: capture.surface,
					path: `captures/${capture.fileName}`,
					width: dimensions.width,
					height: dimensions.height,
					sha256: sha256Hex(capture.pngBytes),
					pageErrors: {
						rows: capture.pageErrors.slice(0, PAGE_ERROR_CAP),
						more: Math.max(0, capture.pageErrors.length - PAGE_ERROR_CAP),
					},
					errorCoverage: {pageerror: "readable" as const, consoleError: "readable" as const},
				})),
			};
			const manifestWrite = yield* Effect.tryPromise({
				try: async () => {
					await mkdir(options.outputDir, {recursive: true});
					await writeFile(join(options.outputDir, "manifest.json"), JSON.stringify(manifest));
				},
				catch: (cause) => String(cause),
			}).pipe(Effect.result);
			if (manifestWrite._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot write the capture manifest (${manifestWrite.failure}).`,
				);
			}
			return answer(JSON.stringify(manifest));
		}).pipe(Effect.ensuring(cleanup));
	});
