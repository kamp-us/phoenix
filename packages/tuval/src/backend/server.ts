import {spawn} from "node:child_process";
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import {fileURLToPath} from "node:url";
import type {ByteTransportFactory} from "@earendil-works/pi-client";
import {
	type CurrentUser,
	FateInterpreter,
	type LivePublisher,
	type LiveTopicPublisher,
} from "@kampus/fate-effect";
import {Effect, Exit, Fiber, FileSystem, Layer, Queue, Schema, Scope, Stream} from "effect";
import * as Semaphore from "effect/Semaphore";
import type {ExtensionUISnapshot} from "../shared/extension-ui.js";
import type {RestorationSnapshot, WorkspaceStateDocument} from "../shared/resilience.js";
import {
	ExtensionUI,
	type ExtensionUIService,
	makeDurableExtensionUI,
	makeExtensionUI,
} from "./extension-ui.js";
import {TuvalFateServerLive} from "./fate.js";
import {LineageIndex, LineageIndexLive, type LineageIndexOptions} from "./lineage.js";
import {
	LiveSession,
	type LiveSessionReconnectOptions,
	type LiveSessionService,
	makeDurableLiveSession,
	makeResilientPiLiveSession,
	makeUnavailableLiveSession,
} from "./live-session.js";
import {
	type ActivatedPackageContributions,
	activatePackageContributions,
	emitContributionCatalog,
	type LoadPackageContributionsOptions,
	loadPackageContributions,
	type TuvalContributionCatalog,
} from "./package-contributions.js";
import {PiDiscovery, PiDiscoveryLive, type PiDiscoveryOptions} from "./pi-discovery.js";
import {
	makeMemoryWorkspaceStateStore,
	makeOperationalPackageRegistrations,
	makeOperationalWorkspaceSettings,
	OperationalPackageRegistrations,
	OperationalWorkspaceSettings,
	type PackageRegistrationsService,
	resilienceDiagnostic,
	restoreWorkspace,
	type WorkspaceSettingsService,
	type WorkspaceStateStore,
} from "./resilience.js";

export const TUVAL_HOST = "127.0.0.1";

export class StartupFailure extends Schema.TaggedErrorClass<StartupFailure>()(
	"tuval/StartupFailure",
	{message: Schema.String, cause: Schema.optionalKey(Schema.Defect())},
) {
	override readonly name = "StartupFailure";
}

export interface StartTuvalOptions extends PiDiscoveryOptions {
	readonly port?: number;
	readonly lineage?: LineageIndexOptions;
	readonly openBrowser?: (url: string) => Effect.Effect<void, unknown>;
	readonly staticAsset?: string;
	readonly packageContributions?: LoadPackageContributionsOptions;
	readonly log?: (line: string) => void;
	readonly liveSession?: LiveSessionService;
	readonly liveSessionTransport?: ByteTransportFactory;
	readonly extensionUI?: ExtensionUIService;
	readonly reconnect?: LiveSessionReconnectOptions;
	readonly workspaceStateStore?: WorkspaceStateStore;
	readonly operationalWorkspaceSettings?: WorkspaceSettingsService;
	readonly operationalPackageRegistrations?: PackageRegistrationsService;
	readonly requestDispatchGate?: Effect.Effect<void>;
	readonly onRequestQueued?: () => void;
}

export interface RunningTuval {
	readonly host: typeof TUVAL_HOST;
	readonly port: number;
	readonly url: string;
	readonly pid: number;
	readonly close: () => Effect.Effect<void, StartupFailure>;
}

const bodyOf = Effect.fn("TuvalServer.bodyOf")((request: IncomingMessage) =>
	Effect.tryPromise({
		try: async () => {
			if (request.method === "GET" || request.method === "HEAD") return undefined;
			const chunks: Array<Buffer> = [];
			for await (const chunk of request) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			return Buffer.concat(chunks);
		},
		catch: (cause) => new StartupFailure({message: "Tuval could not read the request body", cause}),
	}),
);

const toWebRequest = Effect.fn("TuvalServer.toWebRequest")(function* (
	request: IncomingMessage,
	origin: string,
) {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else if (value !== undefined) {
			headers.set(name, value);
		}
	}
	const body = yield* bodyOf(request);
	return new Request(new URL(request.url ?? "/", origin), {
		method: request.method ?? "GET",
		headers,
		...(body === undefined ? {} : {body}),
	});
});

const writeWebResponse = Effect.fn("TuvalServer.writeWebResponse")(
	(response: Response, target: ServerResponse) =>
		Effect.tryPromise({
			try: async () => {
				target.statusCode = response.status;
				response.headers.forEach((value, name) => {
					target.setHeader(name, value);
				});
				target.end(Buffer.from(await response.arrayBuffer()));
			},
			catch: (cause) => new StartupFailure({message: "Tuval could not write the response", cause}),
		}),
);

const defaultOpenBrowser = Effect.fn("TuvalServer.openBrowser")((url: string) =>
	Effect.callback<void, StartupFailure>((resume) => {
		const command =
			process.platform === "darwin"
				? {file: "open", args: [url]}
				: process.platform === "win32"
					? {file: "cmd", args: ["/c", "start", "", url]}
					: {file: "xdg-open", args: [url]};
		const child = spawn(command.file, command.args, {detached: true, stdio: "ignore"});
		child.once("error", (cause) =>
			resume(Effect.fail(new StartupFailure({message: "Tuval could not open the browser", cause}))),
		);
		child.once("spawn", () => {
			child.unref();
			resume(Effect.void);
		});
	}),
);

const closeServer = Effect.fn("TuvalServer.close")((server: Server) =>
	Effect.callback<void, StartupFailure>((resume) => {
		server.close((cause) =>
			resume(
				cause === undefined
					? Effect.void
					: Effect.fail(new StartupFailure({message: "Tuval failed while shutting down", cause})),
			),
		);
	}),
);

const noTopicPublisher: LiveTopicPublisher = {
	appendNode: () => Effect.void,
	prependNode: () => Effect.void,
	deleteEdge: () => Effect.void,
	invalidate: () => Effect.void,
};

const fateContext = {
	currentUser: {user: undefined} satisfies typeof CurrentUser.Service,
	livePublisher: {
		update: () => Effect.void,
		delete: () => Effect.void,
		invalidate: () => Effect.void,
		topic: () => noTopicPublisher,
	} satisfies typeof LivePublisher.Service,
};

const sseFrame = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;

const afterSequenceOf = (url: URL): {readonly valid: boolean; readonly sequence?: number} => {
	const value = url.searchParams.get("afterSequence");
	if (value === null) return {valid: true};
	if (!/^\d+$/.test(value)) return {valid: false};
	const sequence = Number(value);
	return Number.isSafeInteger(sequence) ? {valid: true, sequence} : {valid: false};
};

const writeFailure = (response: ServerResponse, error: unknown): void => {
	if (response.headersSent) {
		response.end();
		return;
	}
	response.statusCode = 500;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(
		JSON.stringify({
			error: error instanceof Error ? error.message : "Unknown Tuval server failure",
		}),
	);
};

const responseClosed = (response: ServerResponse) =>
	Effect.callback<void>((resume) => {
		const close = () => resume(Effect.void);
		response.once("close", close);
		return Effect.sync(() => response.off("close", close));
	});

const endQueuedResponse = Effect.fn("TuvalServer.endQueuedResponse")((response: ServerResponse) =>
	Effect.callback<void>((resume) => {
		const done = () => resume(Effect.void);
		response.once("finish", done);
		response.once("close", done);
		response.statusCode = 503;
		response.end("Tuval is shutting down");
		return Effect.sync(() => {
			response.off("finish", done);
			response.off("close", done);
		});
	}),
);

const handleRequest = Effect.fn("TuvalServer.handleRequest")(function* (
	request: IncomingMessage,
	response: ServerResponse,
	origin: string,
	staticAsset: string,
	fs: typeof FileSystem.FileSystem.Service,
	contributions: TuvalContributionCatalog,
	restoration: RestorationSnapshot,
) {
	const url = new URL(request.url ?? "/", origin);
	if (request.method === "GET" && url.pathname === "/health") {
		response.setHeader("content-type", "application/json; charset=utf-8");
		response.end(JSON.stringify({status: "ready", url: origin, pid: process.pid}));
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/resilience") {
		response.setHeader("content-type", "application/json; charset=utf-8");
		response.end(JSON.stringify(restoration));
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/contributions") {
		response.setHeader("content-type", "application/json; charset=utf-8");
		response.end(JSON.stringify(emitContributionCatalog(contributions)));
		return;
	}
	if (request.method === "GET" && url.pathname.startsWith("/api/contribution-assets/")) {
		const asset = contributions.assetFiles.get(url.pathname);
		if (asset === undefined) {
			response.statusCode = 404;
			response.end("Contribution asset unavailable");
			return;
		}
		response.setHeader("content-type", "text/javascript; charset=utf-8");
		response.setHeader("cache-control", "no-cache");
		response.setHeader("x-content-type-options", "nosniff");
		response.end(asset);
		return;
	}
	if (request.method === "POST" && url.pathname === "/fate") {
		const webRequest = yield* toWebRequest(request, origin);
		const webResponse = yield* FateInterpreter.handleRequest(webRequest, fateContext);
		yield* writeWebResponse(webResponse, response);
		return;
	}
	if (request.method === "GET" && url.pathname === "/fate/extension-ui/live") {
		const extensionUI = yield* ExtensionUI;
		response.statusCode = 200;
		response.setHeader("content-type", "text/event-stream; charset=utf-8");
		response.setHeader("cache-control", "no-cache");
		response.setHeader("connection", "keep-alive");
		response.flushHeaders();
		yield* Stream.callback((queue) =>
			Effect.acquireRelease(
				extensionUI.subscribe((event) => Queue.offerUnsafe(queue, event)),
				(unsubscribe) => Effect.sync(unsubscribe),
			),
		).pipe(Stream.runForEach((event) => Effect.sync(() => response.write(sseFrame(event)))));
		return;
	}
	if (request.method === "GET" && url.pathname === "/fate/live") {
		const afterSequence = afterSequenceOf(url);
		if (!afterSequence.valid) {
			response.statusCode = 400;
			response.end("afterSequence must be a non-negative safe integer");
			return;
		}
		const liveSession = yield* LiveSession;
		response.statusCode = 200;
		response.setHeader("content-type", "text/event-stream; charset=utf-8");
		response.setHeader("cache-control", "no-cache");
		response.setHeader("connection", "keep-alive");
		response.flushHeaders();
		yield* liveSession
			.events(afterSequence.sequence)
			.pipe(Stream.runForEach((event) => Effect.sync(() => response.write(sseFrame(event)))));
		return;
	}
	if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
		response.setHeader("content-type", "text/html; charset=utf-8");
		response.end(yield* fs.readFile(staticAsset));
		return;
	}
	response.statusCode = 404;
	response.end("Not found");
});

export const startTuval = Effect.fn("TuvalServer.start")(function* (
	options: StartTuvalOptions = {},
) {
	const fs = yield* FileSystem.FileSystem;
	const rawExtensionUI = options.extensionUI ?? makeExtensionUI();
	const contributions = yield* loadPackageContributions(options.packageContributions);
	const rawLiveSession =
		options.liveSession ??
		(options.liveSessionTransport === undefined
			? makeUnavailableLiveSession()
			: yield* makeResilientPiLiveSession(options.liveSessionTransport, options.reconnect ?? {}));
	yield* Effect.addFinalizer(() => rawLiveSession.dispose().pipe(Effect.ignore));

	const discoveryOptions = {
		...options,
		...(options.protocolTransport !== undefined || options.liveSessionTransport === undefined
			? {}
			: {protocolTransport: options.liveSessionTransport}),
	};
	const discoveryLayer = PiDiscoveryLive(discoveryOptions);
	const lineageOptions = {
		...options.lineage,
		...(options.lineage?.sessionRoots !== undefined || options.sessionRoots === undefined
			? {}
			: {sessionRoots: options.sessionRoots}),
	};
	const lineageLayer = LineageIndexLive(lineageOptions).pipe(Layer.provide(discoveryLayer));
	const restorationContext = yield* Layer.build(Layer.mergeAll(discoveryLayer, lineageLayer));
	const availablePackageRegistrations = [
		...new Set([
			...contributions.backend.map(({packageName}) => packageName),
			...contributions.frontend.map(({packageName}) => packageName),
		]),
	].sort();
	let extensionUI: ExtensionUIService = rawExtensionUI;
	const packageExtensionUIBridge: ExtensionUIService = {
		dispatch: (...args) => extensionUI.dispatch(...args),
		respond: (...args) => extensionUI.respond(...args),
		cancel: (...args) => extensionUI.cancel(...args),
		unload: (...args) => extensionUI.unload(...args),
		restore: (...args) => extensionUI.restore(...args),
		snapshots: () => extensionUI.snapshots(),
		subscribe: (...args) => extensionUI.subscribe(...args),
		disconnect: () => extensionUI.disconnect(),
	};
	let activeContributions: TuvalContributionCatalog = {
		...contributions,
		backend: [],
		frontend: [],
		assetFiles: new Map(),
	};
	let backendContributionDiagnostics: TuvalContributionCatalog["diagnostics"] = [];
	let activeContributionScope: Scope.Closeable | undefined;
	let preparedActivation:
		| {
				readonly scope: Scope.Closeable;
				readonly activated: ActivatedPackageContributions;
		  }
		| undefined;
	const preparePackageRegistrations = (requestedPackages: ReadonlyArray<string>) =>
		Effect.gen(function* () {
			const requested = new Set(requestedPackages);
			const frontend = contributions.frontend.filter(({packageName}) => requested.has(packageName));
			const assets = new Set(frontend.map(({asset}) => asset));
			const scope = yield* Scope.make();
			const activated = yield* activatePackageContributions(
				{
					...contributions,
					backend: contributions.backend.filter(({packageName}) => requested.has(packageName)),
					frontend,
					assetFiles: new Map([...contributions.assetFiles].filter(([asset]) => assets.has(asset))),
				},
				packageExtensionUIBridge,
			).pipe(
				Effect.provideService(Scope.Scope, scope),
				Effect.onError(() => Scope.close(scope, Exit.void)),
			);
			preparedActivation = {scope, activated};
			const failedPackageNames: ReadonlySet<string> = activated.failedPackageNames;
			return requestedPackages.filter((packageName) => !failedPackageNames.has(packageName));
		});
	const commitPackageRegistrations = () =>
		Effect.sync(() => {
			if (preparedActivation === undefined) return;
			activeContributions = preparedActivation.activated.catalog;
			backendContributionDiagnostics = preparedActivation.activated.diagnostics;
			activeContributionScope = preparedActivation.scope;
			preparedActivation = undefined;
		});
	const rollbackPackageRegistrations = Effect.fn("TuvalServer.rollbackPackageRegistrations")(
		function* () {
			if (preparedActivation !== undefined) {
				yield* Scope.close(preparedActivation.scope, Exit.void);
				preparedActivation = undefined;
			}
			activeContributions = {...contributions, backend: [], frontend: [], assetFiles: new Map()};
		},
	);
	const operationalSettings =
		options.operationalWorkspaceSettings ?? makeOperationalWorkspaceSettings();
	const operationalRegistrations =
		options.operationalPackageRegistrations ??
		makeOperationalPackageRegistrations(availablePackageRegistrations);
	const workspaceStateStore = options.workspaceStateStore ?? makeMemoryWorkspaceStateStore();
	const durableRestoration = options.workspaceStateStore !== undefined;
	const restored = yield* restoreWorkspace({
		store: workspaceStateStore,
		discover: () =>
			durableRestoration
				? Effect.gen(function* () {
						const discovery = yield* PiDiscovery;
						return yield* discovery.discover();
					}).pipe(Effect.provideContext(restorationContext))
				: Effect.succeed({_tag: "empty" as const, sessions: [] as const}),
		restoreLineage: () =>
			durableRestoration
				? Effect.gen(function* () {
						const lineage = yield* LineageIndex;
						return yield* lineage.project();
					}).pipe(Effect.provideContext(restorationContext))
				: Effect.void,
		restoreSelection: (sessionId) =>
			rawLiveSession
				.restoreSelectionIntent(sessionId)
				.pipe(Effect.map((outcome) => outcome._tag === "attached")),
		clearSelectionIntent: () =>
			rawLiveSession.clearSelectionIntent?.() ?? rawLiveSession.release().pipe(Effect.asVoid),
		restoreSettings: operationalSettings.restore,
		readSettings: operationalSettings.read,
		availablePackageRegistrations: operationalRegistrations.available,
		preparePackageRegistrations,
		restorePackageRegistrations: operationalRegistrations.restore,
		commitPackageRegistrations,
		rollbackPackageRegistrations,
		restoreExtensionUI: rawExtensionUI.restore,
	});
	const activeNames = new Set(restored.packageRegistrations);
	yield* Effect.addFinalizer(() =>
		activeContributionScope === undefined
			? Effect.void
			: Scope.close(activeContributionScope, Exit.void),
	);
	let packageDiagnostics: Array<ReturnType<typeof resilienceDiagnostic>> = [];
	const transportDiagnostics = (yield* rawLiveSession.eventsAfter(0)).flatMap((event) =>
		event._tag === "diagnostic" && event.diagnostic !== undefined ? [event.diagnostic] : [],
	);
	const persistenceDiagnostics: Array<ReturnType<typeof resilienceDiagnostic>> = [];
	const restoration = (): RestorationSnapshot => ({
		...restored,
		packageRegistrations: [...activeNames].sort(),
		diagnostics: [
			...restored.diagnostics,
			...transportDiagnostics,
			...packageDiagnostics,
			...persistenceDiagnostics,
		].map(resilienceDiagnostic),
	});
	let liveSession: LiveSessionService = rawLiveSession;
	const persistenceSemaphore = yield* Semaphore.make(1);
	const recordPersistenceFailure = Effect.sync(() => {
		if (!persistenceDiagnostics.some(({code}) => code === "workspace-state-save-failed")) {
			persistenceDiagnostics.push(
				resilienceDiagnostic({
					category: "persistence",
					code: "workspace-state-save-failed",
					message: "Workspace state could not be durably persisted",
					action: "Repair the workspace state store before retrying the operation",
				}),
			);
		}
		return false;
	});
	const persistWorkspace = (
		candidateExtensionUI?: ReadonlyArray<ExtensionUISnapshot>,
		commitExtensionUI: () => void = () => {},
		candidateSessionId?: string | null,
	): Effect.Effect<boolean> =>
		persistenceSemaphore
			.withPermit(
				Effect.gen(function* () {
					const [selectionIntent, extensionUISnapshots, settings, packageRegistrations] =
						yield* Effect.all(
							[
								rawLiveSession.selectionIntent(),
								candidateExtensionUI === undefined
									? rawExtensionUI.snapshots()
									: Effect.succeed(candidateExtensionUI),
								operationalSettings.read(),
								Effect.succeed([...activeNames]),
							],
							{concurrency: 1},
						);
					const document: WorkspaceStateDocument = {
						version: 1,
						selectedSessionId:
							candidateSessionId === undefined ? selectionIntent : candidateSessionId,
						settings,
						packageRegistrations: [...packageRegistrations],
						extensionUI: extensionUISnapshots,
					};
					const warning = yield* workspaceStateStore.save(document);
					if (warning._tag === "committed-with-warning") {
						persistenceDiagnostics.push(resilienceDiagnostic(warning.diagnostic));
					}
					yield* Effect.sync(commitExtensionUI);
					return true;
				}),
			)
			.pipe(Effect.catch(() => recordPersistenceFailure));
	liveSession = makeDurableLiveSession(rawLiveSession, (candidateSessionId, commit) =>
		persistWorkspace(undefined, commit, candidateSessionId),
	);
	extensionUI = makeDurableExtensionUI(rawExtensionUI, persistWorkspace);
	packageDiagnostics = [...contributions.diagnostics, ...backendContributionDiagnostics].map(
		(diagnostic) =>
			resilienceDiagnostic({
				category: "package",
				code: diagnostic.reason,
				message: diagnostic.message,
				action: "Review the package manifest or registration; other packages remain available",
				packageName: diagnostic.packageName,
			}),
	);
	yield* persistWorkspace();
	const serviceLayers = Layer.mergeAll(
		discoveryLayer,
		lineageLayer,
		Layer.succeed(LiveSession, liveSession),
		Layer.succeed(ExtensionUI, extensionUI),
		Layer.succeed(OperationalWorkspaceSettings, operationalSettings),
		Layer.succeed(OperationalPackageRegistrations, operationalRegistrations),
	);
	const fateLayer = TuvalFateServerLive.pipe(Layer.provide(serviceLayers));
	const appContext = yield* Layer.build(Layer.mergeAll(fateLayer, serviceLayers));
	yield* Effect.addFinalizer(() => persistWorkspace().pipe(Effect.ignore));
	const staticAsset =
		options.staticAsset ?? fileURLToPath(new URL("../frontend-shell/index.html", import.meta.url));
	let origin = `http://${TUVAL_HOST}`;
	type RequestJob = {readonly request: IncomingMessage; readonly response: ServerResponse};
	const requests = yield* Queue.unbounded<RequestJob>();
	const requestSupervisor = yield* Effect.forkScoped(
		Effect.forever(
			(options.requestDispatchGate ?? Effect.void).pipe(
				Effect.andThen(Queue.take(requests)),
				Effect.flatMap(({request, response}) =>
					Effect.forkChild(
						Effect.raceFirst(
							handleRequest(
								request,
								response,
								origin,
								staticAsset,
								fs,
								activeContributions,
								restoration(),
							).pipe(
								Effect.catch((error) => Effect.sync(() => writeFailure(response, error))),
								Effect.provideContext(appContext),
							),
							responseClosed(response),
						).pipe(
							Effect.ensuring(
								Effect.sync(() => {
									if (!response.writableEnded) response.end();
								}),
							),
						),
					),
				),
			),
		),
	);
	let acceptingRequests = true;
	const server = createServer((request, response) => {
		if (!acceptingRequests || !Queue.offerUnsafe(requests, {request, response})) {
			response.statusCode = 503;
			response.end("Tuval is shutting down");
			return;
		}
		options.onRequestQueued?.();
	});
	const port = options.port ?? 0;
	yield* Effect.callback<void, StartupFailure>((resume) => {
		const onError = (cause: Error) => {
			server.off("listening", onListening);
			resume(
				Effect.fail(
					new StartupFailure({
						message: `Tuval could not bind ${TUVAL_HOST}:${port}. Check whether the port is already in use.`,
						cause,
					}),
				),
			);
		};
		const onListening = () => {
			server.off("error", onError);
			resume(Effect.void);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, TUVAL_HOST);
	});

	let closed = false;
	const close = Effect.fn("TuvalServer.close")(() =>
		Effect.suspend(() => {
			if (closed) return Effect.void;
			closed = true;
			return Effect.gen(function* () {
				acceptingRequests = false;
				yield* persistWorkspace();
				yield* Fiber.interrupt(requestSupervisor);
				const queued = yield* Queue.takeBetween(requests, 0, Number.POSITIVE_INFINITY);
				yield* Effect.forEach(queued, ({response}) => endQueuedResponse(response), {
					concurrency: 1,
					discard: true,
				});
				yield* Queue.shutdown(requests);
				yield* Effect.sync(() => server.closeAllConnections());
				yield* closeServer(server);
			});
		}),
	);
	yield* Effect.addFinalizer(() => close().pipe(Effect.ignore));

	const address = server.address();
	if (address === null || typeof address === "string") {
		return yield* new StartupFailure({message: "Tuval bound without a TCP address"});
	}
	origin = `http://${TUVAL_HOST}:${address.port}`;
	options.log?.(`Tuval ready at ${origin}`);
	yield* (options.openBrowser ?? defaultOpenBrowser)(origin).pipe(
		Effect.catch((error) =>
			Effect.sync(() =>
				options.log?.(
					`Tuval is ready, but the browser could not be opened: ${
						error instanceof Error ? error.message : String(error)
					}`,
				),
			),
		),
	);
	return {
		host: TUVAL_HOST,
		port: address.port,
		url: origin,
		pid: process.pid,
		close,
	} satisfies RunningTuval;
});
