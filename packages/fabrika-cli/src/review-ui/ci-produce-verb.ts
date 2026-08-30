import {type ChildProcess, spawn} from "node:child_process";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
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

interface StartedServer {
	readonly child: ChildProcess;
	readonly url: string;
}

const stop = (child: ChildProcess): Promise<void> =>
	new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, 5_000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
		child.kill("SIGTERM");
	});

const start = (
	command: readonly string[],
	cwd: string,
	env: Readonly<Record<string, string | undefined>>,
	readinessPattern: string,
): Effect.Effect<StartedServer, string> =>
	Effect.tryPromise({
		try: () =>
			new Promise<StartedServer>((resolve, reject) => {
				const [file, ...args] = command;
				if (file === undefined) {
					reject(new Error("the server command is empty"));
					return;
				}
				const pattern = new RegExp(readinessPattern);
				const child = spawn(file, args, {cwd, env: {...env}, stdio: ["ignore", "pipe", "pipe"]});
				let stdout = "";
				let stderr = "";
				let settled = false;
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					child.kill("SIGKILL");
					reject(new Error("the localhost harness did not report readiness within 20 seconds"));
				}, 20_000);
				child.stdout?.on("data", (chunk) => {
					stdout += chunk.toString();
					const match = pattern.exec(stdout);
					const url = match?.[1];
					if (settled || url === undefined) return;
					settled = true;
					clearTimeout(timer);
					resolve({child, url});
				});
				child.stderr?.on("data", (chunk) => {
					stderr += chunk.toString();
				});
				child.once("error", (cause) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(cause);
				});
				child.once("exit", (code) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(new Error(`the localhost harness exited before readiness (${code}): ${stderr}`));
				});
			}),
		catch: (cause) => String(cause),
	});

const captureLocalhost = (
	options: CiProduceOptions,
	serverCommand: readonly string[],
	readinessPattern: string,
	captureReadySelector: string,
	surfaces: ReadonlyArray<{
		readonly id: string;
		readonly route: string;
		readonly state: string;
		readonly width: number;
		readonly height: number;
	}>,
): Effect.Effect<readonly CapturedSurface[], string> =>
	Effect.acquireUseRelease(
		Effect.tryPromise({
			try: async () => {
				const fixtureRoot = await mkdtemp(join(tmpdir(), "fabrika-review-ui-localhost-"));
				const sessionRoot = join(fixtureRoot, "sessions");
				await mkdir(sessionRoot, {recursive: true});
				await writeFile(
					join(sessionRoot, "2026-08-29T10-00-00-000Z_review-ui.jsonl"),
					`${JSON.stringify({
						type: "session",
						version: 3,
						id: "review-ui",
						timestamp: "2026-08-29T10:00:00.000Z",
						cwd: "/work/review-ui",
					})}\n`,
				);
				const started = await Effect.runPromise(
					start(
						serverCommand,
						options.subjectRoot,
						{...isolatedEnvironment(options.env), TUVAL_SESSION_ROOT: sessionRoot},
						readinessPattern,
					),
				);
				return {...started, fixtureRoot};
			},
			catch: (cause) => String(cause),
		}),
		(started) => {
			const shots: Shot[] = surfaces.map((surface) => ({
				surface: {surface: surface.id, route: surface.route, state: surface.state},
				url: new URL(surface.route, started.url).toString(),
				viewport: {label: surface.state, width: surface.width, height: surface.height},
				fileName: `${surface.id}.png`,
			}));
			return captureShots(shots, join(options.outputDir, "captures"), {
				fullPage: true,
				waitUntil: "load",
				readySelector: captureReadySelector,
			}).pipe(Effect.mapError((cause) => cause.message));
		},
		(started) =>
			Effect.tryPromise({
				try: async () => {
					await stop(started.child);
					await rm(started.fixtureRoot, {recursive: true, force: true});
				},
				catch: () => undefined,
			}).pipe(Effect.ignore),
	);

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
		const repo = options.repository;

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

		const checkedOut = yield* execRecord({
			file: "git",
			args: ["rev-parse", "HEAD"],
			cwd: options.subjectRoot,
			env: isolatedEnvironment(options.env),
			timeoutSeconds: 30,
			captureBytes: 4_096,
		});
		const checkedOutHead =
			checkedOut._tag === "Ran" && checkedOut.exitCode === 0
				? new TextDecoder().decode(checkedOut.stdout).trim()
				: "";
		if (checkedOutHead !== options.head) {
			return refuse(
				STALE_TREE,
				`${VERB}: the subject checkout is ${checkedOutHead || "unreadable"}, not ${options.head}.`,
			);
		}

		const [command, ...args] = harness.captureCommand;
		if (command === undefined) {
			return refuse(MALFORMED_DOCUMENT, `${VERB}: the governed capture command is empty.`);
		}
		const execution = yield* execRecord({
			file: command,
			args,
			cwd: options.subjectRoot,
			env: isolatedEnvironment(options.env),
			timeoutSeconds: 1_200,
			captureBytes: 1_048_576,
		});
		if (execution._tag === "Unstartable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: the capture command could not start (${execution.reason}).`,
			);
		}
		if (execution.exitCode !== 0 || execution.timedOut || execution.truncated) {
			const diagnostics = new TextDecoder()
				.decode(execution.stderr.length > 0 ? execution.stderr : execution.stdout)
				.trim();
			return refuse(
				RENDER_CRASHED,
				`${VERB}: the governed Tuval browser journey failed (${diagnostics || `exit ${execution.exitCode ?? "timeout"}`}).`,
			);
		}
		const captures = yield* captureLocalhost(
			options,
			harness.serverCommand,
			harness.readinessPattern,
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
			repository: repo,
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
			captures: validatedCaptures.map(([capture, dimensions]) => {
				return {
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
				};
			}),
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
