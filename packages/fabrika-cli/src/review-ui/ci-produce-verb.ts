import {chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {isAbsolute, join, resolve, sep} from "node:path";
import {Effect, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CapturedSurface, captureShots} from "../capture/capture.ts";
import type {Shot} from "../capture/plan.ts";
import {validateCaptureBytes} from "../capture/png.ts";
import {type ChildRunner, execRecord} from "../io/exec.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	INVALID_CAPTURE,
	MALFORMED_DOCUMENT,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	STALE_TREE,
	SURFACE_UNREACHABLE,
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
	/** Process seam for timeout/cleanup tests; production uses execRecord. */
	readonly runner?: ChildRunner;
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

const containerGuardArgs = (memory = "2g"): readonly string[] => [
	"--read-only",
	"--cap-drop",
	"ALL",
	"--security-opt",
	"no-new-privileges",
	"--cpus",
	"2",
	"--memory",
	memory,
	"--memory-swap",
	memory,
	"--pids-limit",
	"256",
	"--tmpfs",
	"/tmp:rw,nosuid,nodev,size=64m",
];

const boundedVolumeCreateArgs = (name: string, size: string): readonly string[] => [
	"volume",
	"create",
	"--driver",
	"local",
	"--opt",
	"type=tmpfs",
	"--opt",
	"device=tmpfs",
	"--opt",
	`o=size=${size}`,
	name,
];

export const subjectVolumeCreateArgs = (name: string): readonly string[] =>
	boundedVolumeCreateArgs(name, "2g");

export const subjectInstallAndTestContainerArgs = (
	image: string,
	volume: string,
	command: readonly string[],
	name = `${image}-test`,
): readonly string[] => [
	"run",
	"--rm",
	"--network",
	"none",
	"--name",
	name,
	...containerGuardArgs("4g"),
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
	buildCommand: readonly string[],
	name = `${image}-server-prepare`,
): readonly string[] => [
	"run",
	"--rm",
	"--network",
	"none",
	"--name",
	name,
	...containerGuardArgs(),
	"--mount",
	`type=volume,src=${volume},dst=/subject`,
	"--workdir",
	"/subject",
	"--entrypoint",
	"sh",
	image,
	"-c",
	'cp -a /subject-source/. /subject/ && pnpm install --offline --frozen-lockfile --ignore-scripts --ignore-pnpmfile && exec "$@"',
	"--",
	...buildCommand,
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
	outputVolume: string,
	containerPort: number,
	harness: string,
	name = `${server}-capture`,
): readonly string[] => [
	"run",
	"--rm",
	"--network",
	`container:${server}`,
	"--name",
	name,
	...containerGuardArgs(),
	"--mount",
	`type=bind,src=${authorityRoot},dst=/authority,readonly`,
	"--mount",
	`type=volume,src=${outputVolume},dst=/capture-output`,
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

const boundedVolumeKeeperContainerArgs = (
	image: string,
	volume: string,
	name: string,
	mountPoint: string,
): readonly string[] => [
	"run",
	"--detach",
	"--network",
	"none",
	"--name",
	name,
	"--read-only",
	"--cap-drop",
	"ALL",
	"--security-opt",
	"no-new-privileges",
	"--cpus",
	"0.1",
	"--memory",
	"64m",
	"--memory-swap",
	"64m",
	"--pids-limit",
	"16",
	"--tmpfs",
	"/tmp:rw,nosuid,nodev,size=4m",
	"--mount",
	`type=volume,src=${volume},dst=${mountPoint}`,
	"--entrypoint",
	"node",
	image,
	"--eval",
	"setInterval(() => {}, 2147483647)",
];

export const subjectVolumeKeeperContainerArgs = (
	image: string,
	volume: string,
	name: string,
): readonly string[] => boundedVolumeKeeperContainerArgs(image, volume, name, "/subject");

export const captureVolumeKeeperContainerArgs = (
	image: string,
	volume: string,
	name: string,
): readonly string[] => boundedVolumeKeeperContainerArgs(image, volume, name, "/capture-output");

export const captureOutputContainerArgs = (
	image: string,
	volume: string,
	outputDir: string,
	name: string,
): readonly string[] => [
	"run",
	"--rm",
	"--network",
	"none",
	"--name",
	name,
	...containerGuardArgs(),
	"--mount",
	`type=volume,src=${volume},dst=/capture,readonly`,
	"--mount",
	`type=bind,src=${outputDir},dst=/output`,
	"--entrypoint",
	"sh",
	image,
	"-c",
	"cp -a /capture/. /output/",
];

export interface TrustedFixtureOperations {
	readonly mkdtemp: (prefix: string) => Promise<string>;
	readonly mkdir: (path: string) => Promise<void>;
	readonly writeFile: (path: string, data: string) => Promise<void>;
	readonly chmod: (path: string, mode: number) => Promise<void>;
	readonly rm: (path: string) => Promise<void>;
}

const trustedFixtureOperations: TrustedFixtureOperations = {
	mkdtemp,
	mkdir: async (path) => {
		await mkdir(path, {recursive: true});
	},
	writeFile: (path, data) => writeFile(path, data),
	chmod,
	rm: (path) => rm(path, {recursive: true, force: true}),
};

export const createFixture = async (
	operations: TrustedFixtureOperations = trustedFixtureOperations,
): Promise<string> => {
	const root = await operations.mkdtemp(join(tmpdir(), "fabrika-review-ui-localhost-"));
	const sessions = join(root, "sessions");
	const fixture = join(sessions, "2026-08-29T10-00-00-000Z_review-ui.jsonl");
	const setup = operations
		.mkdir(sessions)
		.then(() =>
			operations.writeFile(
				fixture,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: "review-ui",
					timestamp: "2026-08-29T10:00:00.000Z",
					cwd: "/work/review-ui",
				})}\n`,
			),
		)
		.then(() => operations.chmod(root, 0o755))
		.then(() => operations.chmod(sessions, 0o755))
		.then(() => operations.chmod(fixture, 0o644));
	return setup.then(
		() => root,
		(cause) =>
			operations.rm(root).then(
				() => Promise.reject(cause),
				(cleanupCause) =>
					Promise.reject(
						new Error(`${String(cause)}; fixture cleanup failed (${String(cleanupCause)})`, {
							cause,
						}),
					),
			),
	);
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const isDockerResourceAlreadyAbsent = (
	kind: "container" | "volume" | "image",
	name: string,
	diagnostic: string,
): boolean => {
	const target = escapeRegex(name);
	const exact =
		kind === "container"
			? `Error response from daemon: No such container: ${target}`
			: kind === "volume"
				? `Error response from daemon: (?:No such volume: ${target}|(?:get|remove) ${target}: no such volume)`
				: `Error response from daemon: No such image: ${target}(?::latest)?`;
	return new RegExp(`^${exact}$`).test(diagnostic.trim());
};

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
		const ran = (
			file: string,
			args: readonly string[],
			cwd: string,
			env: Readonly<Record<string, string>>,
			timeoutSeconds: number,
		) =>
			(options.runner ?? execRecord)({
				file,
				args,
				cwd,
				env,
				timeoutSeconds,
				captureBytes: 1_048_576,
			});
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
		const testContainer = `${image}-test`;
		const prepareContainer = `${image}-server-prepare`;
		const serverKeeperContainer = `${image}-server-keeper`;
		const container = `${image}-server`;
		const captureContainer = `${image}-capture`;
		const captureKeeperContainer = `${image}-capture-keeper`;
		const extractContainer = `${image}-capture-extract`;
		const testVolume = `${image}-test-workspace`;
		const serverVolume = `${image}-server-workspace`;
		const captureVolume = `${image}-capture-output`;
		const fixtureRead = yield* Effect.tryPromise({
			try: () => createFixture(),
			catch: (cause) => String(cause),
		}).pipe(Effect.result);
		if (fixtureRead._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot create the trusted fixture (${fixtureRead.failure}).`,
			);
		}
		const fixtureRoot = fixtureRead.success;
		const containersToClean = [
			testContainer,
			prepareContainer,
			serverKeeperContainer,
			container,
			captureContainer,
			captureKeeperContainer,
			extractContainer,
		];
		const volumesToClean = [testVolume, serverVolume, captureVolume];
		const cleanup = Effect.gen(function* () {
			const failures: string[] = [];
			const cleanDockerResource = (kind: "container" | "volume" | "image", name: string) =>
				Effect.gen(function* () {
					const args =
						kind === "container" ? ["rm", "--force", name] : [kind, "rm", "--force", name];
					const result = yield* ran(
						"docker",
						args,
						options.authorityRoot,
						env,
						kind === "image" ? 60 : 30,
					);
					const diagnostic =
						result._tag === "Ran"
							? `${decode(result.stdout)}\n${decode(result.stderr)}`
							: result.reason;
					const alreadyAbsent =
						result._tag === "Ran" &&
						result.exitCode !== 0 &&
						!result.timedOut &&
						!result.truncated &&
						isDockerResourceAlreadyAbsent(kind, name, diagnostic);
					if (
						!alreadyAbsent &&
						(result._tag !== "Ran" || result.exitCode !== 0 || result.timedOut || result.truncated)
					) {
						failures.push(
							`${kind} ${name}: ${diagnostic.trim() || (result._tag === "Ran" ? `exit ${result.exitCode}` : "cleanup command failed")}`,
						);
					}
				});
			for (const name of containersToClean) yield* cleanDockerResource("container", name);
			for (const volume of volumesToClean) yield* cleanDockerResource("volume", volume);
			yield* cleanDockerResource("image", image);
			const fixtureRemoval = yield* Effect.tryPromise({
				try: () => rm(fixtureRoot, {recursive: true, force: true}),
				catch: (cause) => String(cause),
			}).pipe(Effect.result);
			if (fixtureRemoval._tag === "Failure") {
				failures.push(`fixture ${fixtureRoot}: ${fixtureRemoval.failure}`);
			}
			return failures;
		});

		const operation = Effect.gen(function* () {
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
					subjectVolumeCreateArgs(volume),
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
				subjectInstallAndTestContainerArgs(
					image,
					testVolume,
					harness.captureCommand,
					testContainer,
				),
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

			const serverKeeper = yield* ran(
				"docker",
				subjectVolumeKeeperContainerArgs(image, serverVolume, serverKeeperContainer),
				options.authorityRoot,
				env,
				30,
			);
			const serverKeeperId =
				serverKeeper._tag === "Ran" && serverKeeper.exitCode === 0
					? decode(serverKeeper.stdout)
					: "";
			const keeperRunning = (keeperId: string) =>
				ran(
					"docker",
					["inspect", "--format", "{{.State.Running}}", keeperId],
					options.authorityRoot,
					env,
					10,
				).pipe(
					Effect.map(
						(result) =>
							result._tag === "Ran" &&
							result.exitCode === 0 &&
							!result.timedOut &&
							!result.truncated &&
							decode(result.stdout) === "true",
					),
				);
			if (
				serverKeeper._tag !== "Ran" ||
				serverKeeper.exitCode !== 0 ||
				serverKeeper.timedOut ||
				serverKeeper.truncated ||
				serverKeeperId === "" ||
				!(yield* keeperRunning(serverKeeperId))
			) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: the bounded server workspace could not be kept alive.`,
				);
			}

			const preparedServer = yield* ran(
				"docker",
				subjectPrepareServerContainerArgs(
					image,
					serverVolume,
					harness.serverBuildCommand,
					prepareContainer,
				),
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
			if (!(yield* keeperRunning(serverKeeperId))) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: the bounded server workspace keeper exited during preparation.`,
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
			if (!(yield* keeperRunning(serverKeeperId))) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: the bounded server workspace keeper exited during server startup.`,
				);
			}

			let ready = false;
			for (let attempt = 0; attempt < 80; attempt += 1) {
				const logs = yield* ran("docker", ["logs", containerId], options.authorityRoot, env, 10);
				const logText = logs._tag === "Ran" ? `${decode(logs.stdout)}\n${decode(logs.stderr)}` : "";
				if (new RegExp(harness.readinessPattern).test(logText)) {
					ready = true;
					break;
				}
				const inspected = yield* ran(
					"docker",
					["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", containerId],
					options.authorityRoot,
					env,
					10,
				);
				if (
					inspected._tag === "Ran" &&
					inspected.exitCode === 0 &&
					decode(inspected.stdout).startsWith("false ")
				) {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: the isolated subject server exited before readiness (${decode(inspected.stdout)}${logText.trim() === "" ? "" : `; ${logText.trim()}`}).`,
					);
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
				const captureVolumeCreated = yield* ran(
					"docker",
					boundedVolumeCreateArgs(captureVolume, "256m"),
					options.authorityRoot,
					env,
					30,
				);
				if (captureVolumeCreated._tag !== "Ran" || captureVolumeCreated.exitCode !== 0) {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: the bounded capture workspace could not be created.`,
					);
				}
				const captureKeeper = yield* ran(
					"docker",
					captureVolumeKeeperContainerArgs(image, captureVolume, captureKeeperContainer),
					options.authorityRoot,
					env,
					30,
				);
				const captureKeeperId =
					captureKeeper._tag === "Ran" && captureKeeper.exitCode === 0
						? decode(captureKeeper.stdout)
						: "";
				if (
					captureKeeper._tag !== "Ran" ||
					captureKeeper.exitCode !== 0 ||
					captureKeeper.timedOut ||
					captureKeeper.truncated ||
					captureKeeperId === ""
				) {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: the bounded capture workspace could not be kept alive.`,
					);
				}
				if (!(yield* keeperRunning(captureKeeperId))) {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: the bounded capture workspace could not be kept alive.`,
					);
				}
				const sidecar = yield* ran(
					"docker",
					subjectCaptureContainerArgs(
						image,
						containerId,
						options.authorityRoot,
						captureVolume,
						harness.containerPort,
						harness.id,
						captureContainer,
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
				if (!(yield* keeperRunning(captureKeeperId))) {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: the bounded capture workspace could not be kept alive.`,
					);
				}
				const extracted = yield* ran(
					"docker",
					captureOutputContainerArgs(image, captureVolume, options.outputDir, extractContainer),
					options.authorityRoot,
					env,
					60,
				);
				if (
					extracted._tag !== "Ran" ||
					extracted.exitCode !== 0 ||
					extracted.timedOut ||
					extracted.truncated
				) {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: the bounded capture output could not be materialized.`,
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
						SURFACE_UNREACHABLE,
						`${VERB}: capture ${capture.surface} navigation returned no HTTP response.`,
					);
				}
				if (capture.status < 200 || capture.status >= 400) {
					return refuse(
						SURFACE_UNREACHABLE,
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
		});
		let cleanupFailures: readonly string[] = [];
		const operationOutcome = yield* operation.pipe(
			Effect.ensuring(
				cleanup.pipe(
					Effect.tap((failures) =>
						Effect.sync(() => {
							cleanupFailures = failures;
						}),
					),
				),
			),
		);
		if (cleanupFailures.length === 0) return operationOutcome;
		const cleanupDiagnostic = `${VERB}: cleanup failed (${cleanupFailures.join("; ")}).`;
		return operationOutcome.code === 0
			? refuse(PRECONDITION_UNKNOWN, cleanupDiagnostic)
			: {...operationOutcome, stderr: [...operationOutcome.stderr, cleanupDiagnostic]};
	});
