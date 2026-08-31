import {Duration, Effect} from "effect";
import type {ChildOutcome} from "../io/exec.ts";
import {isRecord, parseJson} from "../io/json.ts";

const DEFAULT_DEADLINE_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const COMMAND_TIMEOUT_MAX_MS = 1_000;
const COMMAND_TIMEOUT_FLOOR_MS = 1;
const INSPECT_FORMAT =
	'{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"state":{{json .State}}}';

export interface DockerContainerState {
	readonly id: string;
	readonly name: string;
	readonly image: string;
	readonly status: string;
	readonly running: boolean;
	readonly exitCode: number;
	readonly error: string;
}

export interface DockerReadinessObservation {
	readonly requestedId: string;
	readonly requestedName: string;
	readonly observedAtMs: number;
	readonly logs: ChildOutcome;
	readonly inspect: ChildOutcome;
	readonly state: DockerContainerState | null;
}

export type DockerReadinessResult =
	| {readonly _tag: "Ready"; readonly observation: DockerReadinessObservation}
	| {readonly _tag: "Exited"; readonly observation: DockerReadinessObservation}
	| {readonly _tag: "TimedOut"; readonly observation: DockerReadinessObservation}
	| {
			readonly _tag: "ObservationFailed";
			readonly phase: "logs" | "inspect" | "identity";
			readonly observation: DockerReadinessObservation;
	  };

export interface DockerReadinessOptions<R> {
	readonly containerId: string;
	readonly containerName: string;
	readonly readinessPattern: RegExp;
	readonly run: (
		args: readonly string[],
		timeoutSeconds: number,
	) => Effect.Effect<ChildOutcome, never, R>;
	readonly deadlineMs?: number;
	readonly pollIntervalMs?: number;
	readonly now?: () => number;
	readonly sleep?: (milliseconds: number) => Effect.Effect<void>;
}

const commandSucceeded = (
	outcome: ChildOutcome,
): outcome is Extract<ChildOutcome, {readonly _tag: "Ran"}> =>
	outcome._tag === "Ran" && outcome.exitCode === 0 && !outcome.timedOut && !outcome.truncated;

const decodeBytes = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const parseContainerState = (outcome: ChildOutcome): DockerContainerState | null => {
	if (!commandSucceeded(outcome)) return null;
	const value = parseJson(decodeBytes(outcome.stdout));
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.name !== "string" ||
		typeof value.image !== "string" ||
		!isRecord(value.state) ||
		typeof value.state.Status !== "string" ||
		typeof value.state.Running !== "boolean" ||
		typeof value.state.ExitCode !== "number" ||
		typeof value.state.Error !== "string"
	) {
		return null;
	}
	return {
		id: value.id,
		name: value.name,
		image: value.image,
		status: value.state.Status,
		running: value.state.Running,
		exitCode: value.state.ExitCode,
		error: value.state.Error,
	};
};

const hasReadiness = (pattern: RegExp, outcome: ChildOutcome): boolean => {
	if (!commandSucceeded(outcome)) return false;
	pattern.lastIndex = 0;
	if (pattern.test(decodeBytes(outcome.stdout))) return true;
	pattern.lastIndex = 0;
	return pattern.test(decodeBytes(outcome.stderr));
};

export const waitForDockerReadiness = <R>(
	options: DockerReadinessOptions<R>,
): Effect.Effect<DockerReadinessResult, never, R> =>
	Effect.gen(function* () {
		const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
		const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		const now = options.now ?? performance.now.bind(performance);
		const sleep =
			options.sleep ?? ((milliseconds: number) => Effect.sleep(Duration.millis(milliseconds)));
		const startedAt = now();
		const deadline = startedAt + deadlineMs;

		while (true) {
			const observedAt = now();
			const atDeadline = observedAt >= deadline;
			const remainingBeforeLogs = Math.max(0, deadline - observedAt);
			const logsBudgetMs = atDeadline
				? COMMAND_TIMEOUT_MAX_MS
				: Math.max(
						COMMAND_TIMEOUT_FLOOR_MS,
						Math.min(COMMAND_TIMEOUT_MAX_MS, remainingBeforeLogs / 2),
					);
			const logs = yield* options.run(["logs", options.containerId], logsBudgetMs / 1_000);
			const remainingBeforeInspect = Math.max(0, deadline - now());
			const inspectBudgetMs = atDeadline
				? COMMAND_TIMEOUT_MAX_MS
				: Math.max(
						COMMAND_TIMEOUT_FLOOR_MS,
						Math.min(COMMAND_TIMEOUT_MAX_MS, remainingBeforeInspect),
					);
			const inspect = yield* options.run(
				["inspect", "--format", INSPECT_FORMAT, options.containerId],
				inspectBudgetMs / 1_000,
			);
			const state = parseContainerState(inspect);
			const observation: DockerReadinessObservation = {
				requestedId: options.containerId,
				requestedName: options.containerName,
				observedAtMs: Math.max(0, observedAt - startedAt),
				logs,
				inspect,
				state,
			};

			if (!commandSucceeded(logs)) {
				return {_tag: "ObservationFailed", phase: "logs", observation};
			}
			if (state === null) {
				return {_tag: "ObservationFailed", phase: "inspect", observation};
			}
			if (state.id !== options.containerId) {
				return {_tag: "ObservationFailed", phase: "identity", observation};
			}
			if (!state.running) return {_tag: "Exited", observation};
			if (hasReadiness(options.readinessPattern, logs)) return {_tag: "Ready", observation};

			if (atDeadline) return {_tag: "TimedOut", observation};
			const remainingAfterObservation = deadline - now();
			if (remainingAfterObservation > 0) {
				yield* sleep(Math.min(pollIntervalMs, remainingAfterObservation));
			}
		}
	});

const renderedOutcome = (outcome: ChildOutcome): string => {
	if (outcome._tag === "Unstartable") return `unstartable=${JSON.stringify(outcome.reason)}`;
	return [
		`exit=${String(outcome.exitCode)}`,
		`timedOut=${String(outcome.timedOut)}`,
		`truncated=${String(outcome.truncated)}`,
		`stdoutBytes=${outcome.stdout.length}`,
		`stdout=${JSON.stringify(decodeBytes(outcome.stdout))}`,
		`stderrBytes=${outcome.stderr.length}`,
		`stderr=${JSON.stringify(decodeBytes(outcome.stderr))}`,
	].join(" ");
};

export const formatDockerReadinessFailure = (
	result: Exclude<DockerReadinessResult, {readonly _tag: "Ready"}>,
): string => {
	const {observation} = result;
	const state = observation.state;
	const identity =
		state === null
			? "observedIdentity=unreadable"
			: `observedId=${JSON.stringify(state.id)} observedName=${JSON.stringify(state.name)} image=${JSON.stringify(state.image)} status=${JSON.stringify(state.status)} running=${String(state.running)} exitCode=${state.exitCode} stateError=${JSON.stringify(state.error)}`;
	const phase = result._tag === "ObservationFailed" ? ` phase=${result.phase}` : "";
	return [
		`readiness=${result._tag}${phase}`,
		`requestedId=${JSON.stringify(observation.requestedId)} requestedName=${JSON.stringify(observation.requestedName)}`,
		identity,
		`observedAtMs=${observation.observedAtMs}`,
		`logs(${renderedOutcome(observation.logs)})`,
		`inspect(${renderedOutcome(observation.inspect)})`,
	].join("; ");
};
