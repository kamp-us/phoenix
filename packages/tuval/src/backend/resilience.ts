import type {SettingsManager} from "@earendil-works/pi-coding-agent";
import {Context, Crypto, Effect, FileSystem, Path, Result, Schema} from "effect";
import type {DiscoveryOutcome} from "../shared/discovery.js";
import type {ExtensionUISnapshot} from "../shared/extension-ui.js";
import {
	emptyWorkspaceState,
	type ResilienceDiagnostic,
	type ResilienceDiagnosticCategory,
	type ResilienceDiagnosticCode,
	type RestorationSnapshot,
	type RestorationStage,
	type WorkspaceSettings,
	WorkspaceStateDocument,
	type WorkspaceStateDocument as WorkspaceStateDocumentType,
} from "../shared/resilience.js";

export class WorkspaceStateStoreError extends Schema.TaggedErrorClass<WorkspaceStateStoreError>()(
	"tuval/WorkspaceStateStoreError",
	{operation: Schema.Literals(["load", "save"]), message: Schema.String},
) {}

export interface WorkspaceStateLoad {
	readonly source: "missing" | "persisted";
	readonly document: WorkspaceStateDocumentType;
	readonly diagnostics: ReadonlyArray<ResilienceDiagnostic>;
}

export interface WorkspaceStateStore {
	readonly load: () => Effect.Effect<WorkspaceStateLoad, WorkspaceStateStoreError>;
	readonly save: (
		document: WorkspaceStateDocumentType,
	) => Effect.Effect<void, WorkspaceStateStoreError>;
}

export interface WorkspaceSettingsService {
	readonly read: () => Effect.Effect<WorkspaceSettings, unknown>;
	readonly restore: (settings: WorkspaceSettings) => Effect.Effect<void, unknown>;
}

export class OperationalWorkspaceSettings extends Context.Service<
	OperationalWorkspaceSettings,
	WorkspaceSettingsService
>()("tuval/OperationalWorkspaceSettings") {}

export interface PackageRegistrationsService {
	readonly available: ReadonlyArray<string>;
	readonly read: () => Effect.Effect<ReadonlyArray<string>, unknown>;
	readonly restore: (packages: ReadonlyArray<string>) => Effect.Effect<void, unknown>;
}

export class OperationalPackageRegistrations extends Context.Service<
	OperationalPackageRegistrations,
	PackageRegistrationsService
>()("tuval/OperationalPackageRegistrations") {}

export const makeOperationalWorkspaceSettings = (
	initial: WorkspaceSettings = {},
): WorkspaceSettingsService & {readonly current: () => WorkspaceSettings} => {
	let current = {...initial};
	return {
		read: () => Effect.succeed({...current}),
		restore: (settings) =>
			Effect.sync(() => {
				current = {...settings};
			}),
		current: () => ({...current}),
	};
};

const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** Adapts the persisted public workspace subset to pi's real SettingsManager. */
export const makePiOperationalWorkspaceSettings = (
	manager: SettingsManager,
): WorkspaceSettingsService => ({
	read: () =>
		Effect.sync(() => {
			const pairs: Array<readonly [string, string | undefined]> = [
				["theme", manager.getThemeSetting()],
				["defaultProvider", manager.getDefaultProvider()],
				["defaultModel", manager.getDefaultModel()],
				["defaultThinkingLevel", manager.getDefaultThinkingLevel()],
				["steeringMode", manager.getSteeringMode()],
				["followUpMode", manager.getFollowUpMode()],
			];
			return Object.fromEntries(
				pairs.filter((pair): pair is readonly [string, string] => pair[1] !== undefined),
			);
		}),
	restore: (settings) =>
		Effect.tryPromise({
			try: async () => {
				if (settings.theme !== undefined) manager.setTheme(settings.theme);
				if (settings.defaultProvider !== undefined) {
					manager.setDefaultProvider(settings.defaultProvider);
				}
				if (settings.defaultModel !== undefined) manager.setDefaultModel(settings.defaultModel);
				if (
					settings.defaultThinkingLevel !== undefined &&
					thinkingLevels.has(settings.defaultThinkingLevel)
				) {
					manager.setDefaultThinkingLevel(
						settings.defaultThinkingLevel as Parameters<typeof manager.setDefaultThinkingLevel>[0],
					);
				}
				if (settings.steeringMode === "all" || settings.steeringMode === "one-at-a-time") {
					manager.setSteeringMode(settings.steeringMode);
				}
				if (settings.followUpMode === "all" || settings.followUpMode === "one-at-a-time") {
					manager.setFollowUpMode(settings.followUpMode);
				}
				await manager.flush();
			},
			catch: (cause) => cause,
		}),
});

export const makeOperationalPackageRegistrations = (
	available: ReadonlyArray<string>,
): PackageRegistrationsService & {readonly current: () => ReadonlyArray<string>} => {
	const known = [...new Set(available)].sort();
	let current = [...known];
	return {
		available: known,
		read: () => Effect.succeed([...current]),
		restore: (packages) =>
			Effect.sync(() => {
				current = [...new Set(packages)].filter((name) => known.includes(name)).sort();
			}),
		current: () => [...current],
	};
};

const sensitiveKey = /(?:token|secret|password|authorization|api[-_]?key|prompt|transcript)/i;
const sensitiveAssignment =
	/\b(token|secret|password|authorization|api[-_]?key)\b["']?\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi;
const bearer = /\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const contentAssignment = /\b(prompt|transcript)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const unixPath = /(?:^|[\s("'])\/(?:[^\s)"']+\/?)+/g;
const windowsPath = /\b[A-Za-z]:\\(?:[^\s"']+\\?)+/g;

const redactJsonValue = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(redactJsonValue);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => [
			key,
			sensitiveKey.test(key) ? "[redacted]" : redactJsonValue(child),
		]),
	);
};

/** Redacts categorical JSON fields before applying conservative free-text redaction. */
export const redactDiagnosticText = (value: string): string => {
	const parsed = Result.try({
		try: () => JSON.parse(value) as unknown,
		catch: () => undefined,
	});
	const source =
		Result.isSuccess(parsed) && parsed.success !== undefined
			? JSON.stringify(redactJsonValue(parsed.success))
			: value;
	return source
		.replace(sensitiveAssignment, (_match, key: string) => `${key}=[redacted]`)
		.replace(bearer, "Bearer [redacted]")
		.replace(contentAssignment, (_match, kind: string) => `${kind}=[redacted]`)
		.replace(windowsPath, "[local-path]")
		.replace(unixPath, (match) => `${match[0]?.trim() === "" ? match[0] : ""}[local-path]`);
};

const redactDiagnosticCorrelation = (value: string): string =>
	/[\\/]|\b(token|secret|password|authorization|prompt|transcript)\b/i.test(value)
		? "[redacted]"
		: value;

export const resilienceDiagnostic = (input: {
	readonly category: ResilienceDiagnosticCategory;
	readonly code: ResilienceDiagnosticCode;
	readonly message: string;
	readonly action: string;
	readonly sessionId?: string;
	readonly packageName?: string;
}): ResilienceDiagnostic => ({
	category: input.category,
	code: input.code,
	message: redactDiagnosticText(input.message),
	action: redactDiagnosticText(input.action),
	...(input.sessionId === undefined
		? {}
		: {sessionId: redactDiagnosticCorrelation(input.sessionId)}),
	...(input.packageName === undefined
		? {}
		: {packageName: redactDiagnosticCorrelation(input.packageName)}),
});

export const makeMemoryWorkspaceStateStore = (
	initial?: WorkspaceStateDocumentType,
): WorkspaceStateStore & {readonly current: () => WorkspaceStateDocumentType} => {
	let source: WorkspaceStateLoad["source"] = initial === undefined ? "missing" : "persisted";
	let document = structuredClone(initial ?? emptyWorkspaceState());
	return {
		load: () => Effect.succeed({source, document: structuredClone(document), diagnostics: []}),
		save: (next) =>
			Effect.sync(() => {
				document = structuredClone(next);
				source = "persisted";
			}),
		current: () => structuredClone(document),
	};
};

export const makeFileWorkspaceStateStore = Effect.fn("TuvalResilience.fileStore")(function* (
	storePath: string,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const crypto = yield* Crypto.Crypto;
	const resolvedStorePath = path.resolve(storePath);
	const decodeDomain = <A>(input: {
		readonly parsed: Record<string, unknown>;
		readonly key: string;
		readonly decode: (value: unknown) => A | undefined;
		readonly fallback: A;
		readonly category: ResilienceDiagnosticCategory;
		readonly code: ResilienceDiagnosticCode;
		readonly message: string;
		readonly action: string;
	}): {readonly value: A; readonly diagnostic?: ResilienceDiagnostic} => {
		const decoded = input.decode(input.parsed[input.key]);
		if (decoded !== undefined) return {value: decoded};
		return {
			value: input.fallback,
			diagnostic: resilienceDiagnostic({
				category: input.category,
				code: input.code,
				message: input.message,
				action: input.action,
			}),
		};
	};
	const rejectUnsafeTarget = Effect.fn("TuvalResilience.rejectUnsafeTarget")(function* () {
		const linked = yield* Effect.result(fs.readLink(resolvedStorePath));
		if (Result.isSuccess(linked)) {
			return yield* new WorkspaceStateStoreError({
				operation: "save",
				message: "Workspace state target is not a regular local file",
			});
		}
	});
	return {
		load: Effect.fn("TuvalResilience.load")(function* () {
			yield* rejectUnsafeTarget().pipe(
				Effect.mapError(
					() =>
						new WorkspaceStateStoreError({
							operation: "load",
							message: "Workspace state target is not a regular local file",
						}),
				),
			);
			const read = yield* Effect.result(fs.readFileString(resolvedStorePath));
			if (Result.isFailure(read)) {
				if (read.failure.reason._tag === "NotFound") {
					return {source: "missing" as const, document: emptyWorkspaceState(), diagnostics: []};
				}
				return yield* new WorkspaceStateStoreError({
					operation: "load",
					message: "Workspace state is unreadable",
				});
			}
			const parsed = yield* Effect.try({
				try: () => JSON.parse(read.success) as unknown,
				catch: () =>
					new WorkspaceStateStoreError({
						operation: "load",
						message: "Workspace state is not valid JSON",
					}),
			});
			if (
				parsed === null ||
				typeof parsed !== "object" ||
				Array.isArray(parsed) ||
				(parsed as {version?: unknown}).version !== 1
			) {
				return yield* new WorkspaceStateStoreError({
					operation: "load",
					message: "Workspace state has an unsupported top-level shape or version",
				});
			}
			const object = parsed as Record<string, unknown>;
			const selection = decodeDomain({
				parsed: object,
				key: "selectedSessionId",
				decode: (value) => {
					const decoded = Schema.decodeUnknownOption(Schema.NullOr(Schema.String))(value);
					return decoded._tag === "Some" ? decoded.value : undefined;
				},
				fallback: null,
				category: "persistence",
				code: "selected-session-state-invalid",
				message: "Persisted selected-session state was invalid",
				action: "Select a retained session again; other workspace state was preserved",
			});
			const settings = decodeDomain({
				parsed: object,
				key: "settings",
				decode: (value) => {
					const decoded = Schema.decodeUnknownOption(WorkspaceStateDocument.fields.settings)(value);
					return decoded._tag === "Some" ? decoded.value : undefined;
				},
				fallback: {},
				category: "persistence",
				code: "workspace-settings-invalid",
				message: "Persisted workspace settings were invalid",
				action: "Review workspace settings; other workspace state was preserved",
			});
			const registrations = decodeDomain({
				parsed: object,
				key: "packageRegistrations",
				decode: (value) => {
					const decoded = Schema.decodeUnknownOption(
						WorkspaceStateDocument.fields.packageRegistrations,
					)(value);
					return decoded._tag === "Some" ? decoded.value : undefined;
				},
				fallback: [],
				category: "package",
				code: "package-registrations-invalid",
				message: "Persisted package registrations were invalid",
				action: "Review package registrations; other workspace state was preserved",
			});
			const extensionUI = decodeDomain({
				parsed: object,
				key: "extensionUI",
				decode: (value) => {
					const decoded = Schema.decodeUnknownOption(WorkspaceStateDocument.fields.extensionUI)(
						value,
					);
					return decoded._tag === "Some" ? decoded.value : undefined;
				},
				fallback: [],
				category: "ui-bridge",
				code: "extension-ui-current-invalid",
				message: "Persisted extension UI current state was invalid",
				action: "Reload the affected extension; other workspace state was preserved",
			});
			return {
				source: "persisted" as const,
				document: {
					version: 1,
					selectedSessionId: selection.value,
					settings: settings.value,
					packageRegistrations: registrations.value,
					extensionUI: extensionUI.value,
				},
				diagnostics: [
					selection.diagnostic,
					settings.diagnostic,
					registrations.diagnostic,
					extensionUI.diagnostic,
				].filter((diagnostic): diagnostic is ResilienceDiagnostic => diagnostic !== undefined),
			};
		}),
		save: Effect.fn("TuvalResilience.save")(function* (document: WorkspaceStateDocumentType) {
			yield* rejectUnsafeTarget();
			const encoded = yield* Schema.encodeEffect(WorkspaceStateDocument)(document).pipe(
				Effect.mapError(
					() =>
						new WorkspaceStateStoreError({
							operation: "save",
							message: "Workspace state could not be encoded",
						}),
				),
			);
			const directory = path.dirname(resolvedStorePath);
			const temporaryPath = path.join(
				directory,
				`.${path.basename(resolvedStorePath)}.${yield* crypto.randomUUIDv4.pipe(
					Effect.mapError(
						() =>
							new WorkspaceStateStoreError({
								operation: "save",
								message: "Workspace state temporary identity could not be allocated",
							}),
					),
				)}.tmp`,
			);
			const bytes = new TextEncoder().encode(`${JSON.stringify(encoded, null, 2)}\n`);
			yield* fs.makeDirectory(directory, {recursive: true}).pipe(
				Effect.andThen(
					Effect.scoped(
						Effect.gen(function* () {
							const file = yield* fs.open(temporaryPath, {flag: "w", mode: 0o600});
							yield* file.writeAll(bytes);
							yield* file.sync;
						}),
					),
				),
				Effect.andThen(fs.rename(temporaryPath, resolvedStorePath)),
				Effect.andThen(
					Effect.scoped(
						fs
							.open(directory, {flag: "r"})
							.pipe(Effect.flatMap((directoryFile) => directoryFile.sync)),
					),
				),
				Effect.ensuring(fs.remove(temporaryPath).pipe(Effect.ignore)),
				Effect.mapError(
					() =>
						new WorkspaceStateStoreError({
							operation: "save",
							message: "Workspace state could not be persisted",
						}),
				),
			);
		}),
	} satisfies WorkspaceStateStore;
});

export interface RestorationDependencies {
	readonly store: WorkspaceStateStore;
	readonly discover: () => Effect.Effect<DiscoveryOutcome, unknown>;
	readonly restoreLineage: () => Effect.Effect<unknown, unknown>;
	readonly restoreSelection: (sessionId: string) => Effect.Effect<boolean, unknown>;
	readonly restoreSettings: (settings: WorkspaceSettings) => Effect.Effect<void, unknown>;
	readonly availablePackageRegistrations: ReadonlyArray<string>;
	readonly restorePackageRegistrations: (
		packages: ReadonlyArray<string>,
	) => Effect.Effect<void, unknown>;
	readonly restoreExtensionUI: (
		snapshots: ReadonlyArray<ExtensionUISnapshot>,
	) => Effect.Effect<void, unknown>;
}

/**
 * Runs every restoration domain in one stable order. Each stage is observed as a Result so one
 * corrupt source cannot prevent later, independent domains from reconstructing their state.
 */
export const restoreWorkspace = Effect.fn("TuvalResilience.restoreWorkspace")(function* (
	dependencies: RestorationDependencies,
) {
	const diagnostics: Array<ResilienceDiagnostic> = [];
	const stages: Array<{stage: RestorationStage; status: "restored" | "degraded"}> = [];
	const mark = (stage: RestorationStage, degraded: boolean) =>
		stages.push({stage, status: degraded ? "degraded" : "restored"});

	const loaded = yield* Effect.result(dependencies.store.load());
	const persisted = Result.isSuccess(loaded) ? loaded.success.document : emptyWorkspaceState();
	if (Result.isSuccess(loaded)) diagnostics.push(...loaded.success.diagnostics);
	if (Result.isFailure(loaded)) {
		diagnostics.push(
			resilienceDiagnostic({
				category: "persistence",
				code: "workspace-state-unavailable",
				message: loaded.failure.message,
				action: "Repair or remove the Tuval workspace state store, then restart Tuval",
			}),
		);
	}

	const discovery = yield* Effect.result(dependencies.discover());
	let discoveredSessionIds = new Set<string>();
	let discoveryDegraded = Result.isFailure(discovery);
	if (Result.isSuccess(discovery)) {
		const outcome = discovery.success;
		if (outcome._tag === "ready" || outcome._tag === "partial-source") {
			discoveredSessionIds = new Set(outcome.sessions.map((session) => session.piSessionId));
		}
		if (outcome._tag === "partial-source") {
			discoveryDegraded = true;
			for (const _problem of outcome.problems) {
				diagnostics.push(
					resilienceDiagnostic({
						category: "startup",
						code: "discovery-source-unavailable",
						message: "A configured session source was unavailable or corrupt",
						action: "Repair that session source; valid sessions remain available",
					}),
				);
			}
		}
		if (outcome._tag === "fatal" || outcome._tag === "transport") {
			discoveryDegraded = true;
			diagnostics.push(
				resilienceDiagnostic({
					category: outcome._tag === "transport" ? "protocol" : "startup",
					code: `discovery-${outcome._tag}`,
					message: outcome.message,
					action: "Check the configured pi session source and retry discovery",
				}),
			);
		}
	} else {
		diagnostics.push(
			resilienceDiagnostic({
				category: "startup",
				code: "discovery-failed",
				message: "Discovery failed while reading a configured source",
				action: "Check the configured pi session source and retry discovery",
			}),
		);
	}
	mark("discovery", discoveryDegraded);

	const lineage = yield* Effect.result(dependencies.restoreLineage());
	if (Result.isFailure(lineage)) {
		diagnostics.push(
			resilienceDiagnostic({
				category: "lineage",
				code: "lineage-restore-failed",
				message: "Durable lineage restoration failed",
				action: "Inspect the durable lineage store; other workspace state remains available",
			}),
		);
	}
	mark("lineage", Result.isFailure(lineage));

	let selectedSessionId: string | null = null;
	let selectionDegraded = false;
	if (persisted.selectedSessionId !== null) {
		const restored = yield* Effect.result(
			dependencies.restoreSelection(persisted.selectedSessionId),
		);
		if (Result.isSuccess(restored) && restored.success) {
			selectedSessionId = persisted.selectedSessionId;
		} else {
			selectionDegraded = true;
			diagnostics.push(
				resilienceDiagnostic({
					category: discoveredSessionIds.has(persisted.selectedSessionId)
						? "protocol"
						: "persistence",
					code: discoveredSessionIds.has(persisted.selectedSessionId)
						? "selected-lease-unavailable"
						: "selected-session-unavailable",
					message: "The selected session could not provide a fresh exclusive lease",
					action:
						"The stale lease was dropped; select another session or retry when pi is available",
					sessionId: persisted.selectedSessionId,
				}),
			);
		}
	}
	mark("selection", selectionDegraded);

	const settings = yield* Effect.result(dependencies.restoreSettings(persisted.settings));
	if (Result.isFailure(settings)) {
		diagnostics.push(
			resilienceDiagnostic({
				category: "persistence",
				code: "settings-restore-failed",
				message: "Workspace settings could not be restored",
				action: "Review workspace settings; package and session restoration continued",
			}),
		);
	}
	mark("settings", Result.isFailure(settings));

	const availablePackages = [...new Set(dependencies.availablePackageRegistrations)].sort();
	const requestedPackages =
		Result.isSuccess(loaded) && loaded.success.source === "missing"
			? availablePackages
			: persisted.packageRegistrations;
	const restoredPackages = requestedPackages
		.filter((packageName) => availablePackages.includes(packageName))
		.sort();
	const missingPackages = requestedPackages
		.filter((packageName) => !availablePackages.includes(packageName))
		.sort();
	for (const packageName of missingPackages) {
		diagnostics.push(
			resilienceDiagnostic({
				category: "package",
				code: "package-registration-unavailable",
				message: "A persisted package registration is no longer available",
				action: "Reinstall or remove the package from workspace settings",
				packageName,
			}),
		);
	}
	const packages = yield* Effect.result(dependencies.restorePackageRegistrations(restoredPackages));
	if (Result.isFailure(packages)) {
		diagnostics.push(
			resilienceDiagnostic({
				category: "package",
				code: "package-registration-restore-failed",
				message: "Package registrations could not be restored",
				action: "Inspect package registrations; other restoration domains continued",
			}),
		);
	}
	mark("package-registrations", missingPackages.length > 0 || Result.isFailure(packages));

	const extensionUI = yield* Effect.result(dependencies.restoreExtensionUI(persisted.extensionUI));
	if (Result.isFailure(extensionUI)) {
		diagnostics.push(
			resilienceDiagnostic({
				category: "ui-bridge",
				code: "extension-ui-current-restore-failed",
				message: "Extension UI current state could not be restored",
				action: "Reload the affected extension; blocking dialogs were not replayed",
			}),
		);
	}
	mark("extension-ui-current", Result.isFailure(extensionUI));

	return {
		stages,
		selectedSessionId,
		settings: persisted.settings,
		packageRegistrations: restoredPackages,
		extensionUI: persisted.extensionUI,
		diagnostics,
	} satisfies RestorationSnapshot;
});
