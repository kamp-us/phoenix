import type {RpcExtensionUIRequest} from "@earendil-works/pi-coding-agent";
import {Context, Effect, Semaphore} from "effect";
import type {
	ExtensionUICancelRequest,
	ExtensionUIDispatchOutcome,
	ExtensionUIEvent,
	ExtensionUIRequest,
	ExtensionUIResponse,
	ExtensionUIResponseOutcome,
	ExtensionUIResponseRequest,
	ExtensionUIScope,
	ExtensionUISnapshot,
	ExtensionUIUnloadOutcome,
} from "../shared/extension-ui.js";
import {extensionUIMethods} from "../shared/extension-ui.js";

export interface ExtensionUIScheduler {
	readonly schedule: (milliseconds: number, run: () => void) => () => void;
}

const liveScheduler: ExtensionUIScheduler = {
	schedule: (milliseconds, run) => {
		const timer = setTimeout(run, milliseconds);
		return () => clearTimeout(timer);
	},
};

const scopeKey = ({packageName, sessionId}: ExtensionUIScope) =>
	`${packageName.length}:${packageName}${sessionId.length}:${sessionId}`;
const requestKey = (scope: ExtensionUIScope, id: string) => `${scopeKey(scope)}:${id}`;
const sameScope = (left: ExtensionUIScope, right: ExtensionUIScope) =>
	left.packageName === right.packageName && left.sessionId === right.sessionId;

interface ScopedState {
	readonly scope: ExtensionUIScope;
	readonly statuses: Map<string, string>;
	readonly widgets: Map<
		string,
		{readonly lines: ReadonlyArray<string>; readonly placement: "aboveEditor" | "belowEditor"}
	>;
}

type BlockingMethod = "select" | "confirm" | "input" | "editor";
type SettleReason = "responded" | "timeout" | "disconnected" | "unloaded" | "cancelled";
interface PendingRequest {
	readonly scope: ExtensionUIScope;
	readonly id: string;
	readonly method: BlockingMethod;
	readonly complete: (outcome: ExtensionUIDispatchOutcome) => void;
	cancelTimer: () => void;
}

type ExtensionUICheckpoint = (
	candidate: ReadonlyArray<ExtensionUISnapshot>,
	commit: () => void,
) => Effect.Effect<boolean>;

export interface ExtensionUIService {
	readonly dispatch: (
		scope: ExtensionUIScope,
		request: RpcExtensionUIRequest,
		checkpoint?: ExtensionUICheckpoint,
	) => Effect.Effect<ExtensionUIDispatchOutcome>;
	readonly respond: (
		request: ExtensionUIResponseRequest,
	) => Effect.Effect<ExtensionUIResponseOutcome>;
	readonly cancel: (request: ExtensionUICancelRequest) => Effect.Effect<ExtensionUIResponseOutcome>;
	readonly unload: (
		scope: ExtensionUIScope,
		checkpoint?: ExtensionUICheckpoint,
	) => Effect.Effect<ExtensionUIUnloadOutcome>;
	readonly restore: (snapshots: ReadonlyArray<ExtensionUISnapshot>) => Effect.Effect<void>;
	readonly snapshots: () => Effect.Effect<ReadonlyArray<ExtensionUISnapshot>>;
	readonly subscribe: (listener: (event: ExtensionUIEvent) => void) => Effect.Effect<() => void>;
	readonly disconnect: () => Effect.Effect<void>;
}

export class ExtensionUI extends Context.Service<ExtensionUI, ExtensionUIService>()(
	"tuval/ExtensionUI",
) {}

export interface PackageExtensionUIService {
	readonly packageName: string;
	readonly dispatch: (
		sessionId: string,
		request: RpcExtensionUIRequest,
	) => Effect.Effect<ExtensionUIDispatchOutcome>;
	readonly unload: (sessionId: string) => Effect.Effect<ExtensionUIUnloadOutcome>;
}

export class PackageExtensionUI extends Context.Service<
	PackageExtensionUI,
	PackageExtensionUIService
>()("tuval/PackageExtensionUI") {}

type UnsequencedEvent = ExtensionUIEvent extends infer Event
	? Event extends {readonly sequence: number}
		? Omit<Event, "sequence">
		: never
	: never;

const isBlocking = (method: ExtensionUIRequest["method"]): method is BlockingMethod =>
	method === "select" || method === "confirm" || method === "input" || method === "editor";

const responseMatches = (method: BlockingMethod, response: ExtensionUIResponse) => {
	if ("cancelled" in response) return true;
	return method === "confirm" ? "confirmed" in response : "value" in response;
};

const cancelledResponse = (id: string): ExtensionUIResponse => ({
	type: "extension_ui_response",
	id,
	cancelled: true,
});

export const makeExtensionUI = (
	scheduler: ExtensionUIScheduler = liveScheduler,
	checkpoint: ExtensionUICheckpoint = (_candidate, commit) =>
		Effect.sync(() => {
			commit();
			return true;
		}),
): ExtensionUIService => {
	const states = new Map<string, ScopedState>();
	const retainedOperations = Semaphore.makeUnsafe(1);
	const pending = new Map<string, PendingRequest>();
	const settled = new Set<string>();
	const listeners = new Set<(event: ExtensionUIEvent) => void>();
	let sequence = 0;

	const stateFor = (scope: ExtensionUIScope) => {
		const key = scopeKey(scope);
		const current = states.get(key);
		if (current !== undefined) return current;
		const created: ScopedState = {
			scope: {...scope},
			statuses: new Map(),
			widgets: new Map(),
		};
		states.set(key, created);
		return created;
	};
	const publish = (event: UnsequencedEvent) => {
		const sequenced = {...event, sequence: ++sequence} as ExtensionUIEvent;
		for (const listener of listeners) listener(sequenced);
	};
	const settle = (
		entry: PendingRequest,
		reason: SettleReason,
		response: ExtensionUIResponse = cancelledResponse(entry.id),
	) => {
		const key = requestKey(entry.scope, entry.id);
		if (pending.get(key) !== entry) return false;
		pending.delete(key);
		settled.add(key);
		entry.cancelTimer();
		const eventOutcome = reason === "cancelled" ? "cancelled" : reason;
		publish({
			_tag: "settled",
			scope: entry.scope,
			id: entry.id,
			method: entry.method,
			outcome: eventOutcome,
		});
		entry.complete(
			reason === "responded"
				? {_tag: "responded", response}
				: {
						_tag: "cancelled",
						reason: reason === "cancelled" ? "cancelled" : reason,
						response,
					},
		);
		return true;
	};
	const cancelScope = (scope: ExtensionUIScope, reason: "disconnected" | "unloaded") => {
		for (const entry of [...pending.values()]) {
			if (sameScope(entry.scope, scope)) settle(entry, reason);
		}
	};
	const snapshotValues = (): ReadonlyArray<ExtensionUISnapshot> =>
		[...states.values()]
			.map((state) => ({
				scope: state.scope,
				statuses: [...state.statuses]
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, text]) => ({key, text})),
				widgets: [...state.widgets]
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, widget]) => ({key, lines: widget.lines, placement: widget.placement})),
			}))
			.filter(({statuses, widgets}) => statuses.length > 0 || widgets.length > 0)
			.sort((left, right) => scopeKey(left.scope).localeCompare(scopeKey(right.scope)));
	const retainedCandidate = (
		scope: ExtensionUIScope,
		request: Extract<ExtensionUIRequest, {method: "setStatus" | "setWidget"}>,
	): ReadonlyArray<ExtensionUISnapshot> => {
		const snapshots = snapshotValues();
		const current = snapshots.find((snapshot) => sameScope(snapshot.scope, scope));
		const statuses = new Map(current?.statuses.map(({key, text}) => [key, text]));
		const widgets = new Map(
			current?.widgets.map(({key, lines, placement}) => [key, {lines, placement}]),
		);
		if (request.method === "setStatus") {
			if (request.statusText === undefined) statuses.delete(request.statusKey);
			else statuses.set(request.statusKey, request.statusText);
		} else {
			if (request.widgetLines === undefined) widgets.delete(request.widgetKey);
			else {
				widgets.set(request.widgetKey, {
					lines: [...request.widgetLines],
					placement: request.widgetPlacement ?? "aboveEditor",
				});
			}
		}
		const candidate: ExtensionUISnapshot = {
			scope: {...scope},
			statuses: [...statuses]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, text]) => ({key, text})),
			widgets: [...widgets]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, widget]) => ({key, ...widget})),
		};
		return [
			...snapshots.filter((snapshot) => !sameScope(snapshot.scope, scope)),
			...(candidate.statuses.length === 0 && candidate.widgets.length === 0 ? [] : [candidate]),
		].sort((left, right) => scopeKey(left.scope).localeCompare(scopeKey(right.scope)));
	};

	const dispatch = (
		scope: ExtensionUIScope,
		rawRequest: RpcExtensionUIRequest,
		operationCheckpoint: ExtensionUICheckpoint = checkpoint,
	) => {
		const request = rawRequest as ExtensionUIRequest;
		const classification = extensionUIMethods[request.method];
		if (classification.support === "unavailable") {
			return Effect.sync(() => {
				publish({
					_tag: "degradation",
					scope,
					id: request.id,
					method: "setTitle",
					outcome: "unavailable",
				});
				return {
					_tag: "unavailable",
					method: request.method,
					reason: "Terminal title control is unavailable in Tuval's multi-session browser",
				} as const;
			});
		}
		if (classification.support === "deferred") {
			return Effect.sync(() => {
				publish({
					_tag: "degradation",
					scope,
					id: request.id,
					method: "set_editor_text",
					outcome: "deferred",
				});
				return {
					_tag: "deferred",
					method: request.method,
					reason: "Editor text application is deferred to the rendered extension UI",
				} as const;
			});
		}
		if (classification.kind === "blocking" && isBlocking(request.method)) {
			if (listeners.size === 0) {
				return Effect.succeed({
					_tag: "unavailable" as const,
					method: request.method,
					reason: "No browser extension UI subscriber is attached",
				});
			}
			const method: BlockingMethod = request.method;
			const key = requestKey(scope, request.id);
			if (pending.has(key) || settled.has(key)) {
				return Effect.succeed({
					_tag: "unavailable" as const,
					method: request.method,
					reason: `Request id ${request.id} is not reusable in this package/session scope`,
				});
			}
			return Effect.callback<ExtensionUIDispatchOutcome>((resume) => {
				const entry: PendingRequest = {
					scope: {...scope},
					id: request.id,
					method,
					complete: (outcome) => resume(Effect.succeed(outcome)),
					cancelTimer: () => {},
				};
				pending.set(key, entry);
				if ("timeout" in request && request.timeout !== undefined) {
					entry.cancelTimer = scheduler.schedule(request.timeout, () => settle(entry, "timeout"));
				}
				publish({_tag: "request", scope, request});
				return Effect.sync(() => settle(entry, "cancelled"));
			});
		}
		if (request.method === "notify") {
			return Effect.sync(() => {
				publish({_tag: "notify", scope, request});
				return {_tag: "accepted", method: request.method} as const;
			});
		}
		if (request.method !== "setStatus" && request.method !== "setWidget") {
			return Effect.die(new Error(`Unhandled extension UI method ${request.method}`));
		}
		return retainedOperations.withPermit(
			Effect.gen(function* () {
				const candidate = retainedCandidate(scope, request);
				const commit = () => {
					const state = stateFor(scope);
					if (request.method === "setStatus") {
						if (request.statusText === undefined) state.statuses.delete(request.statusKey);
						else state.statuses.set(request.statusKey, request.statusText);
						publish({
							_tag: "status",
							scope,
							key: request.statusKey,
							...(request.statusText === undefined ? {} : {text: request.statusText}),
							replay: false,
						});
					} else {
						const placement = request.widgetPlacement ?? "aboveEditor";
						if (request.widgetLines === undefined) state.widgets.delete(request.widgetKey);
						else {
							state.widgets.set(request.widgetKey, {lines: [...request.widgetLines], placement});
						}
						publish({
							_tag: "widget",
							scope,
							key: request.widgetKey,
							...(request.widgetLines === undefined ? {} : {lines: request.widgetLines}),
							placement,
							replay: false,
						});
					}
				};
				if (!(yield* operationCheckpoint(candidate, commit))) {
					return {
						_tag: "unavailable",
						method: request.method,
						reason: "Current extension UI state could not be persisted",
					} as const;
				}
				return {_tag: "accepted", method: request.method} as const;
			}),
		);
	};

	return {
		dispatch,
		respond: Effect.fn("ExtensionUI.respond")((request) =>
			Effect.sync(() => {
				const key = requestKey(request.scope, request.response.id);
				if (settled.has(key)) return {_tag: "duplicate", id: request.response.id} as const;
				const entry = pending.get(key);
				if (entry === undefined) return {_tag: "unknown", id: request.response.id} as const;
				if (!responseMatches(entry.method, request.response)) {
					return {_tag: "method-mismatch", id: request.response.id, method: entry.method} as const;
				}
				settle(entry, "responded", request.response);
				return {_tag: "accepted", id: request.response.id} as const;
			}),
		),
		cancel: Effect.fn("ExtensionUI.cancel")((request) =>
			Effect.sync(() => {
				const key = requestKey(request.scope, request.id);
				if (settled.has(key)) return {_tag: "duplicate", id: request.id} as const;
				const entry = pending.get(key);
				if (entry === undefined) return {_tag: "unknown", id: request.id} as const;
				settle(entry, "cancelled");
				return {_tag: "accepted", id: request.id} as const;
			}),
		),
		unload: Effect.fn("ExtensionUI.unload")((scope, operationCheckpoint = checkpoint) =>
			retainedOperations.withPermit(
				Effect.gen(function* () {
					const candidate = snapshotValues().filter(
						(snapshot) => !sameScope(snapshot.scope, scope),
					);
					const commit = () => {
						cancelScope(scope, "unloaded");
						states.delete(scopeKey(scope));
						for (const key of [...settled]) {
							if (key.startsWith(`${scopeKey(scope)}:`)) settled.delete(key);
						}
						publish({_tag: "unloaded", scope});
					};
					if (!(yield* operationCheckpoint(candidate, commit))) {
						return {
							_tag: "refused",
							scope,
							reason: "Extension unload could not be persisted",
						} as const;
					}
					return {_tag: "unloaded", scope} as const;
				}),
			),
		),
		restore: Effect.fn("ExtensionUI.restore")((snapshots) =>
			Effect.sync(() => {
				// Only retained current state is accepted here. Pending blocking requests, notifications,
				// responses and settled ids intentionally have no persistence representation.
				states.clear();
				for (const snapshot of [...snapshots].sort((left, right) =>
					scopeKey(left.scope).localeCompare(scopeKey(right.scope)),
				)) {
					const state = stateFor(snapshot.scope);
					for (const status of [...snapshot.statuses].sort((left, right) =>
						left.key.localeCompare(right.key),
					)) {
						state.statuses.set(status.key, status.text);
					}
					for (const widget of [...snapshot.widgets].sort((left, right) =>
						left.key.localeCompare(right.key),
					)) {
						state.widgets.set(widget.key, {
							lines: [...widget.lines],
							placement: widget.placement,
						});
					}
				}
			}),
		),
		snapshots: Effect.fn("ExtensionUI.snapshots")(() => Effect.sync(snapshotValues)),
		subscribe: Effect.fn("ExtensionUI.subscribe")((listener) =>
			Effect.sync(() => {
				listeners.add(listener);
				for (const snapshot of snapshotValues()) {
					for (const status of snapshot.statuses) {
						listener({
							_tag: "status",
							sequence: ++sequence,
							scope: snapshot.scope,
							key: status.key,
							text: status.text,
							replay: true,
						});
					}
					for (const widget of snapshot.widgets) {
						listener({
							_tag: "widget",
							sequence: ++sequence,
							scope: snapshot.scope,
							key: widget.key,
							lines: widget.lines,
							placement: widget.placement,
							replay: true,
						});
					}
				}
				let active = true;
				return () => {
					if (!active) return;
					active = false;
					listeners.delete(listener);
					if (listeners.size === 0) {
						for (const entry of [...pending.values()]) settle(entry, "disconnected");
					}
				};
			}),
		),
		disconnect: Effect.fn("ExtensionUI.disconnect")(() =>
			Effect.sync(() => {
				for (const entry of [...pending.values()]) settle(entry, "disconnected");
			}),
		),
	};
};

export const makeDurableExtensionUI = (
	service: ExtensionUIService,
	checkpoint: ExtensionUICheckpoint,
): ExtensionUIService => ({
	dispatch: (scope, request) => service.dispatch(scope, request, checkpoint),
	respond: service.respond,
	cancel: service.cancel,
	unload: (scope) => service.unload(scope, checkpoint),
	restore: service.restore,
	snapshots: service.snapshots,
	subscribe: service.subscribe,
	disconnect: service.disconnect,
});

export const packageExtensionUI = (
	packageName: string,
	bridge: ExtensionUIService,
): PackageExtensionUIService => ({
	packageName,
	dispatch: (sessionId, request) => bridge.dispatch({packageName, sessionId}, request),
	unload: (sessionId) => bridge.unload({packageName, sessionId}),
});
