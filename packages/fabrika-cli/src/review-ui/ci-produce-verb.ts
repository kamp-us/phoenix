import {chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {isAbsolute, join, resolve, sep} from "node:path";
import {Effect, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CapturedSurface, captureShots} from "../capture/capture.ts";
import type {Shot} from "../capture/plan.ts";
import {validateCaptureBytes} from "../capture/png.ts";
import {execRecord} from "../io/exec.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	INVALID_CAPTURE,
	MALFORMED_DOCUMENT,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	STALE_TREE,
} from "./codes.ts";
import {
	BROWSER_ERROR_TEXT_CAP,
	type CiCaptureManifest,
	declarationDigest,
	LOCALHOST_DECLARATIONS_PATH,
	parseLocalhostDeclarations,
} from "./localhost-evidence.ts";
import {PAGE_ERROR_CAP, sha256Hex} from "./manifest.ts";

const VERB = "review-ui ci-produce";
const FULL_SHA = /^[0-9a-f]{40}$/;
const SUBJECT_DOCKERFILE = ".github/review-ui-localhost-subject.Dockerfile";
const CAPTURE_SIDECAR = "/authority/packages/fabrika-cli/src/review-ui/ci-capture-sidecar.ts";
const CAPTURE_RESULT = "capture-result.json";

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
	readonly authorityHead: string;
	readonly harness: string;
	readonly runId: number;
	readonly repository: string;
	readonly subjectRoot: string;
	readonly authorityRoot: string;
	readonly outputDir: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly capture?: typeof captureLocalhost;
	readonly readSidecar?: typeof readSidecarCaptures;
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).trim();

const filesystemErrorCode = (cause: unknown): string | null => {
	if (typeof cause !== "object" || cause === null || !("code" in cause)) return null;
	return typeof cause.code === "string" ? cause.code : null;
};

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

export const subjectInstallAndTestContainerArgs = (
	image: string,
	volume: string,
	command: readonly string[],
): readonly string[] => [
	"run",
	"--rm",
	"--network",
	"none",
	...containerGuardArgs(),
	"--mount",
	`type=volume,src=${volume},dst=/subject`,
	"--workdir",
	"/subject",
	"--entrypoint",
	"sh",
	image,
	"-c",
	'cp -a /subject-source/. /subject/ && pnpm install --offline --frozen-lockfile && exec "$@"',
	"--",
	...command,
];

export const subjectPrepareServerContainerArgs = (
	image: string,
	volume: string,
): readonly string[] => [
	"run",
	"--rm",
	"--network",
	"none",
	...containerGuardArgs(),
	"--mount",
	`type=volume,src=${volume},dst=/subject`,
	"--workdir",
	"/subject",
	"--entrypoint",
	"sh",
	image,
	"-c",
	"cp -a /subject-source/. /subject/ && pnpm install --offline --frozen-lockfile --ignore-scripts --ignore-pnpmfile",
];

export const subjectServerContainerArgs = (
	image: string,
	name: string,
	volume: string,
	fixtureRoot: string,
	command: readonly string[],
): readonly string[] => [
	"run",
	"--detach",
	"--rm",
	"--name",
	name,
	"--network",
	"none",
	...containerGuardArgs(),
	"--mount",
	`type=volume,src=${volume},dst=/subject,readonly`,
	"--workdir",
	"/subject",
	"--mount",
	`type=bind,src=${fixtureRoot},dst=/review-ui-fixture,readonly`,
	"--env",
	"TUVAL_SESSION_ROOT=/review-ui-fixture/sessions",
	image,
	...command,
];

export const subjectCaptureContainerArgs = (
	image: string,
	server: string,
	authorityRoot: string,
	outputDir: string,
	containerPort: number,
	harness: string,
): readonly string[] => [
	"run",
	"--rm",
	"--network",
	`container:${server}`,
	...containerGuardArgs(),
	"--mount",
	`type=bind,src=${authorityRoot},dst=/authority,readonly`,
	"--mount",
	`type=bind,src=${outputDir},dst=/capture-output`,
	"--workdir",
	"/authority",
	"--entrypoint",
	"node",
	image,
	CAPTURE_SIDECAR,
	String(containerPort),
	"/capture-output",
	harness,
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

export const createFixture = (): Promise<string> =>
	mkdtemp(join(tmpdir(), "fabrika-review-ui-localhost-")).then(async (root) => {
		const sessions = join(root, "sessions");
		const fixture = join(sessions, "2026-08-29T10-00-00-000Z_review-ui.jsonl");
		await mkdir(sessions, {recursive: true});
		await writeFile(
			fixture,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "review-ui",
				timestamp: "2026-08-29T10:00:00.000Z",
				cwd: "/work/review-ui",
			})}\n`,
		);
		await chmod(root, 0o755);
		await chmod(sessions, 0o755);
		await chmod(fixture, 0o644);
		return root;
	});

export const boundedBrowserErrors = (
	errors: CapturedSurface["pageErrors"],
): {readonly rows: CapturedSurface["pageErrors"]; readonly more: number} => {
	const pageErrors = errors.filter((error) => error.kind === "pageerror");
	const consoleErrors = errors.filter((error) => error.kind === "console.error");
	return {
		rows: [...pageErrors, ...consoleErrors].slice(0, PAGE_ERROR_CAP).map((error) => ({
			...error,
			text: error.text.slice(0, BROWSER_ERROR_TEXT_CAP),
		})),
		more: Math.max(0, errors.length - PAGE_ERROR_CAP),
	};
};

export const captureLocalhost = (
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

export const readSidecarCaptures = async (
	outputDir: string,
): Promise<readonly CapturedSurface[]> => {
	const resultPath = join(outputDir, CAPTURE_RESULT);
	const resultDocument = await readFile(resultPath, "utf8");
	await rm(resultPath, {force: true});
	const value = parseJson(resultDocument);
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("the capture sidecar returned no capture rows");
	}
	const captures: CapturedSurface[] = [];
	for (const row of value) {
		if (
			!isRecord(row) ||
			typeof row.surface !== "string" ||
			typeof row.route !== "string" ||
			(row.state !== null && typeof row.state !== "string") ||
			typeof row.fileName !== "string" ||
			!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.png$/.test(row.fileName) ||
			!Array.isArray(row.pageErrors) ||
			!row.pageErrors.every(
				(error) =>
					isRecord(error) && typeof error.kind === "string" && typeof error.text === "string",
			)
		) {
			throw new Error("the capture sidecar returned a malformed capture row");
		}
		const localPath = join(outputDir, "captures", row.fileName);
		captures.push({
			surface: row.surface,
			route: row.route,
			state: row.state,
			fileName: row.fileName,
			localPath,
			pngBytes: await readFile(localPath),
			pageErrors: row.pageErrors,
			...(typeof row.status === "number" ? {status: row.status} : {}),
		});
	}
	return captures;
};

export const runCiProduce = (
	options: CiProduceOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (!Number.isInteger(options.pr) || options.pr <= 0) {
			return refuse(FAILED, `${VERB}: ${options.pr} is not a pull-request number.`);
		}
		if (!FULL_SHA.test(options.head)) {
			return refuse(OFF_VOCABULARY, `${VERB}: --head must be one full lowercase 40-character SHA.`);
		}
		if (!FULL_SHA.test(options.authorityHead)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --authority-head must be one full lowercase 40-character SHA.`,
			);
		}
		if (!Number.isInteger(options.runId) || options.runId <= 0) {
			return refuse(OFF_VOCABULARY, `${VERB}: --run-id must be a positive Actions run id.`);
		}
		if (!/^[^/\s]+\/[^/\s]+$/.test(options.repository)) {
			return refuse(OFF_VOCABULARY, `${VERB}: --repository must be one owner/name.`);
		}
		if (
			!isAbsolute(options.subjectRoot) ||
			!isAbsolute(options.authorityRoot) ||
			!isAbsolute(options.outputDir)
		) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --subject-root, --authority-root, and --output-dir must be absolute paths.`,
			);
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
		const subjectCheckout = yield* ran("git", ["rev-parse", "HEAD"], options.subjectRoot, env, 30);
		const subjectHead =
			subjectCheckout._tag === "Ran" && subjectCheckout.exitCode === 0
				? decode(subjectCheckout.stdout)
				: "";
		if (subjectHead !== options.head) {
			return refuse(
				STALE_TREE,
				`${VERB}: the subject checkout is ${subjectHead || "unreadable"}, not ${options.head}.`,
			);
		}
		const authorityCheckout = yield* ran(
			"git",
			["rev-parse", "HEAD"],
			options.authorityRoot,
			env,
			30,
		);
		const authorityHead =
			authorityCheckout._tag === "Ran" && authorityCheckout.exitCode === 0
				? decode(authorityCheckout.stdout)
				: "";
		if (authorityHead !== options.authorityHead) {
			return refuse(
				STALE_TREE,
				`${VERB}: the authority checkout is ${authorityHead || "unreadable"}, not ${options.authorityHead}.`,
			);
		}
		const subjectDockerignore = yield* Effect.tryPromise({
			try: () => lstat(join(options.subjectRoot, ".dockerignore")),
			catch: filesystemErrorCode,
		}).pipe(Effect.result);
		if (Result.isSuccess(subjectDockerignore)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: the exact-head subject must not contain a root .dockerignore.`,
			);
		}
		if (subjectDockerignore.failure !== "ENOENT") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot prove the exact-head subject has no root .dockerignore.`,
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
		const testVolume = `${image}-test-workspace`;
		const serverVolume = `${image}-server-workspace`;
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
			for (const volume of [testVolume, serverVolume]) {
				yield* ran(
					"docker",
					["volume", "rm", "--force", volume],
					options.authorityRoot,
					env,
					30,
				).pipe(Effect.ignore);
			}
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

			for (const volume of [testVolume, serverVolume]) {
				const volumeCreated = yield* ran(
					"docker",
					["volume", "create", volume],
					options.authorityRoot,
					env,
					30,
				);
				if (volumeCreated._tag !== "Ran" || volumeCreated.exitCode !== 0) {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: the isolated subject workspace could not be created.`,
					);
				}
			}

			const tested = yield* ran(
				"docker",
				subjectInstallAndTestContainerArgs(image, testVolume, harness.captureCommand),
				options.authorityRoot,
				env,
				1_200,
			);
			if (tested._tag !== "Ran" || tested.exitCode !== 0 || tested.timedOut || tested.truncated) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: the governed browser journey failed (${tested._tag === "Ran" ? decode(tested.stderr) || `exit ${tested.exitCode}` : tested.reason}).`,
				);
			}

			const preparedServer = yield* ran(
				"docker",
				subjectPrepareServerContainerArgs(image, serverVolume),
				options.authorityRoot,
				env,
				1_200,
			);
			if (
				preparedServer._tag !== "Ran" ||
				preparedServer.exitCode !== 0 ||
				preparedServer.timedOut ||
				preparedServer.truncated
			) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: the fresh exact-head server workspace could not be prepared.`,
				);
			}

			const started = yield* ran(
				"docker",
				subjectServerContainerArgs(
					image,
					container,
					serverVolume,
					fixtureRoot,
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
			let captures: Result.Result<readonly CapturedSurface[], string>;
			if (options.capture !== undefined) {
				captures = yield* options
					.capture(
						`http://127.0.0.1:${harness.containerPort}`,
						options.outputDir,
						harness.captureReadySelector,
						harness.surfaces,
					)
					.pipe(Effect.result);
			} else {
				const outputReady = yield* Effect.tryPromise({
					try: async () => {
						await mkdir(join(options.outputDir, "captures"), {recursive: true});
						await chmod(options.outputDir, 0o777);
						await chmod(join(options.outputDir, "captures"), 0o777);
					},
					catch: (cause) => String(cause),
				}).pipe(Effect.result);
				if (Result.isFailure(outputReady)) {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: the trusted capture output could not be prepared (${outputReady.failure}).`,
					);
				}
				const sidecar = yield* ran(
					"docker",
					subjectCaptureContainerArgs(
						image,
						containerId,
						options.authorityRoot,
						options.outputDir,
						harness.containerPort,
						harness.id,
					),
					options.authorityRoot,
					env,
					300,
				);
				if (
					sidecar._tag !== "Ran" ||
					sidecar.exitCode !== 0 ||
					sidecar.timedOut ||
					sidecar.truncated
				) {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: the trusted isolated capture sidecar failed (${sidecar._tag === "Ran" ? decode(sidecar.stderr) || `exit ${sidecar.exitCode}` : sidecar.reason}).`,
					);
				}
				captures = yield* Effect.tryPromise({
					try: () => (options.readSidecar ?? readSidecarCaptures)(options.outputDir),
					catch: (cause) => String(cause),
				}).pipe(Effect.result);
			}
			if (captures._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: the trusted localhost capture failed (${captures.failure}).`,
				);
			}
			const declarationsBySurface = new Map(
				harness.surfaces.map((surface) => [surface.id, surface] as const),
			);
			if (
				captures.success.length !== harness.surfaces.length ||
				new Set(captures.success.map((capture) => capture.surface)).size !== captures.success.length
			) {
				return refuse(
					INVALID_CAPTURE,
					`${VERB}: the trusted capture set does not contain every declared ${harness.id} surface exactly once.`,
				);
			}
			const validatedCaptures: Array<
				readonly [
					CapturedSurface,
					{readonly width: number; readonly height: number},
					(typeof harness.surfaces)[number],
				]
			> = [];
			for (const capture of captures.success) {
				const declared = declarationsBySurface.get(capture.surface);
				if (
					declared === undefined ||
					capture.route !== declared.route ||
					capture.state !== declared.state ||
					capture.fileName !== `${declared.id}.png`
				) {
					return refuse(
						INVALID_CAPTURE,
						`${VERB}: capture ${capture.surface} does not match its declared route, state, and member.`,
					);
				}
				if (capture.status === undefined) {
					return refuse(
						INVALID_CAPTURE,
						`${VERB}: capture ${capture.surface} navigation returned no HTTP response.`,
					);
				}
				if (capture.status < 200 || capture.status >= 400) {
					return refuse(
						INVALID_CAPTURE,
						`${VERB}: capture ${capture.surface} navigation returned HTTP ${capture.status}, not a successful response.`,
					);
				}
				const valid = validateCaptureBytes(capture.pngBytes);
				if (valid._tag === "Invalid") {
					return refuse(
						INVALID_CAPTURE,
						`${VERB}: ${capture.surface} is not a valid capture (${valid.reason}).`,
					);
				}
				validatedCaptures.push([capture, {width: valid.width, height: valid.height}, declared]);
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
					authorityHead: options.authorityHead,
				},
				captures: validatedCaptures.map(([capture, dimensions, declared]) => ({
					surface: capture.surface,
					route: declared.route,
					state: declared.state,
					path: `captures/${capture.fileName}`,
					width: dimensions.width,
					height: dimensions.height,
					sha256: sha256Hex(capture.pngBytes),
					pageErrors: boundedBrowserErrors(capture.pageErrors),
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
