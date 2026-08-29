import {SettingsManager} from "@earendil-works/pi-coding-agent";
import {NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Fiber, FileSystem, Path} from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as fc from "fast-check";
import {makeExtensionUI} from "../src/backend/extension-ui.js";
import {connectLiveSessionWithBackoff} from "../src/backend/live-session.js";
import {
	makeFileWorkspaceStateStore,
	makeMemoryWorkspaceStateStore,
	makePiOperationalWorkspaceSettings,
	redactDiagnosticText,
	resilienceDiagnostic,
	restoreWorkspace,
	WorkspaceSettingsRestoreError,
	WorkspaceStateStoreError,
	workspaceStateDirectorySyncResult,
} from "../src/backend/resilience.js";
import {sessionIdentity} from "../src/shared/discovery.js";
import {emptyWorkspaceState, type WorkspaceStateDocument} from "../src/shared/resilience.js";

const persisted: WorkspaceStateDocument = {
	version: 1,
	selectedSessionId: "session-one",
	settings: {density: "compact", theme: "dark"},
	packageRegistrations: ["available-package", "removed-package"],
	extensionUI: [
		{
			scope: {packageName: "available-package", sessionId: "session-one"},
			statuses: [{key: "build", text: "ready"}],
			widgets: [{key: "plan", lines: ["one"], placement: "belowEditor"}],
		},
	],
};

const discovered = {
	_tag: "ready" as const,
	sessions: [
		{
			identity: sessionIdentity("session-one"),
			piSessionId: "session-one",
			createdAt: 1,
			updatedAt: 1,
			cwd: "/private/workspace",
			sourceFile: "/private/session.jsonl",
		},
	],
};

describe("Tuval resilience and restoration", () => {
	it.effect(
		"restores independent domains in deterministic order and isolates corrupt lineage",
		() =>
			Effect.gen(function* () {
				const calls: Array<string> = [];
				const extensionUI = makeExtensionUI();
				const restored = yield* restoreWorkspace({
					store: makeMemoryWorkspaceStateStore(persisted),
					discover: () =>
						Effect.sync(() => void calls.push("discovery")).pipe(Effect.as(discovered)),
					restoreLineage: () =>
						Effect.sync(() => void calls.push("lineage")).pipe(
							Effect.andThen(
								Effect.fail(
									new WorkspaceStateStoreError({
										operation: "load",
										message: "failed at /Users/alice/.pi/lineage.json",
									}),
								),
							),
						),
					restoreSelection: (sessionId) =>
						Effect.sync(() => {
							calls.push(`selection:${sessionId}`);
							return true;
						}),
					restoreSettings: (settings) =>
						Effect.sync(() => void calls.push(`settings:${settings.theme}`)),
					availablePackageRegistrations: ["z-package", "available-package"],
					restorePackageRegistrations: (packages) =>
						Effect.sync(() => void calls.push(`packages:${packages.join(",")}`)),
					restoreExtensionUI: (snapshots) =>
						Effect.sync(() => void calls.push("extension-ui")).pipe(
							Effect.andThen(extensionUI.restore(snapshots)),
						),
				});

				assert.deepStrictEqual(
					restored.stages.map(({stage}) => stage),
					[
						"discovery",
						"lineage",
						"selection",
						"settings",
						"package-registrations",
						"extension-ui-current",
					],
				);
				assert.deepStrictEqual(calls, [
					"discovery",
					"lineage",
					"selection:session-one",
					"settings:dark",
					"packages:available-package",
					"extension-ui",
				]);
				assert.strictEqual(restored.selectedSessionId, "session-one");
				assert.deepStrictEqual(yield* extensionUI.snapshots(), persisted.extensionUI);
				assert.deepInclude(
					restored.diagnostics.find(({category}) => category === "lineage"),
					{
						category: "lineage",
						code: "lineage-restore-failed",
						message: "Durable lineage restoration failed",
					},
				);
				assert.deepInclude(
					restored.diagnostics.find(({category}) => category === "package"),
					{
						category: "package",
						code: "package-registration-unavailable",
						packageName: "removed-package",
					},
				);
			}),
	);

	it.effect("drops extension state for unavailable packages with a safe diagnostic", () =>
		Effect.gen(function* () {
			const unavailablePackage = "removed package token=private";
			let applied: ReadonlyArray<(typeof persisted.extensionUI)[number]> = [];
			const restored = yield* restoreWorkspace({
				store: makeMemoryWorkspaceStateStore({
					...persisted,
					extensionUI: [
						...persisted.extensionUI,
						{
							scope: {packageName: unavailablePackage, sessionId: "removed session token=private"},
							statuses: [{key: "secret", text: "must-not-replay"}],
							widgets: [],
						},
						{
							scope: {
								packageName: "installed-unregistered",
								sessionId: "removed session token=private",
							},
							statuses: [{key: "stale", text: "must-not-replay"}],
							widgets: [],
						},
					],
				}),
				discover: () => Effect.succeed(discovered),
				restoreLineage: () => Effect.void,
				restoreSelection: () => Effect.succeed(true),
				restoreSettings: () => Effect.void,
				availablePackageRegistrations: ["available-package", "installed-unregistered"],
				restorePackageRegistrations: () => Effect.void,
				restoreExtensionUI: (snapshots) =>
					Effect.sync(() => {
						applied = snapshots;
					}),
			});
			assert.deepStrictEqual(applied, persisted.extensionUI);
			assert.deepStrictEqual(restored.extensionUI, persisted.extensionUI);
			const diagnostic = restored.diagnostics.find(
				({code, packageName}) =>
					code === "extension-ui-package-unavailable" && packageName?.startsWith("sha256:"),
			);
			assert.isDefined(diagnostic);
			assert.match(diagnostic?.sessionId ?? "", /^sha256:/);
			assert.notInclude(JSON.stringify(diagnostic), "removed session token=private");
			assert.notInclude(JSON.stringify(diagnostic), "private");
			assert.notInclude(JSON.stringify(diagnostic), unavailablePackage);
		}),
	);

	it.effect("clears only a selection proven missing by complete discovery", () =>
		Effect.gen(function* () {
			let attempts = 0;
			let cleared = false;
			const restored = yield* restoreWorkspace({
				store: makeMemoryWorkspaceStateStore({...persisted, selectedSessionId: "missing-session"}),
				discover: () => Effect.succeed(discovered),
				restoreLineage: () => Effect.void,
				restoreSelection: () =>
					Effect.sync(() => {
						attempts += 1;
						return false;
					}),
				clearSelectionIntent: () =>
					Effect.sync(() => {
						cleared = true;
					}),
				restoreSettings: () => Effect.void,
				availablePackageRegistrations: ["available-package"],
				restorePackageRegistrations: () => Effect.void,
				restoreExtensionUI: () => Effect.void,
			});
			assert.strictEqual(attempts, 1);
			assert.isTrue(cleared);
			assert.isNull(restored.selectedSessionId);
			assert.deepInclude(
				restored.diagnostics.find(({code}) => code === "selected-session-unavailable"),
				{category: "persistence", code: "selected-session-unavailable"},
			);
		}),
	);

	it.effect("retains selection intent when discovery cannot prove the session missing", () =>
		Effect.gen(function* () {
			let restoredIntent: string | undefined;
			const restored = yield* restoreWorkspace({
				store: makeMemoryWorkspaceStateStore({...persisted, selectedSessionId: "offline-session"}),
				discover: () =>
					Effect.succeed({_tag: "transport" as const, message: "offline", retryable: true}),
				restoreLineage: () => Effect.void,
				restoreSelection: (sessionId) =>
					Effect.sync(() => {
						restoredIntent = sessionId;
						return false;
					}),
				restoreSettings: () => Effect.void,
				availablePackageRegistrations: ["available-package"],
				restorePackageRegistrations: () => Effect.void,
				restoreExtensionUI: () => Effect.void,
			});
			assert.strictEqual(restoredIntent, "offline-session");
			assert.isNull(restored.selectedSessionId);
			assert.isTrue(restored.diagnostics.some(({code}) => code === "selected-lease-unavailable"));
		}),
	);

	it.effect("rolls back prepared packages when registration restoration fails", () =>
		Effect.gen(function* () {
			let active = false;
			let replayed: ReadonlyArray<(typeof persisted.extensionUI)[number]> = persisted.extensionUI;
			const restored = yield* restoreWorkspace({
				store: makeMemoryWorkspaceStateStore({
					...persisted,
					packageRegistrations: ["available-package"],
				}),
				discover: () => Effect.succeed(discovered),
				restoreLineage: () => Effect.void,
				restoreSelection: () => Effect.succeed(true),
				restoreSettings: () => Effect.void,
				availablePackageRegistrations: ["available-package"],
				preparePackageRegistrations: (packages) =>
					Effect.sync(() => {
						active = true;
						return packages;
					}),
				restorePackageRegistrations: () => Effect.fail("registration persistence refused"),
				rollbackPackageRegistrations: () =>
					Effect.sync(() => {
						active = false;
					}),
				restoreExtensionUI: (snapshots) =>
					Effect.sync(() => {
						replayed = snapshots;
					}),
			});
			assert.isFalse(active);
			assert.deepStrictEqual(restored.packageRegistrations, []);
			assert.deepStrictEqual(restored.extensionUI, []);
			assert.deepStrictEqual(replayed, []);
			assert.isTrue(
				restored.diagnostics.some(({code}) => code === "package-registration-restore-failed"),
			);
		}),
	);

	it.effect("round-trips Pi max thinking and rejects invalid values before mutation", () =>
		Effect.gen(function* () {
			const manager = SettingsManager.inMemory(
				{theme: "light", defaultThinkingLevel: "high"},
				{projectTrusted: true},
			);
			const settings = makePiOperationalWorkspaceSettings(manager);
			yield* settings.restore({theme: "dark", defaultThinkingLevel: "max"});
			assert.deepInclude(yield* settings.read(), {
				theme: "dark",
				defaultThinkingLevel: "max",
			});
			const invalid = yield* Effect.result(
				settings.restore({theme: "must-not-apply", defaultThinkingLevel: "impossible"}),
			);
			assert.strictEqual(invalid._tag, "Failure");
			assert.deepInclude(yield* settings.read(), {
				theme: "dark",
				defaultThinkingLevel: "max",
			});
		}),
	);

	it.effect("sanitizes diagnostics supplied by a store before publication", () =>
		Effect.gen(function* () {
			const restored = yield* restoreWorkspace({
				store: {
					load: () =>
						Effect.succeed({
							source: "persisted" as const,
							document: emptyWorkspaceState(),
							diagnostics: [
								{
									category: "package" as const,
									code: "package-registration-unavailable" as const,
									message: 'prompt="raw secret" at /Users/alice/state.json',
									action: "token=private",
									packageName: "package token=private",
								},
							],
						}),
					save: () => Effect.succeed({_tag: "durable" as const}),
				},
				discover: () => Effect.succeed({_tag: "empty" as const, sessions: []}),
				restoreLineage: () => Effect.void,
				restoreSelection: () => Effect.succeed(false),
				restoreSettings: () => Effect.void,
				availablePackageRegistrations: [],
				restorePackageRegistrations: () => Effect.void,
				restoreExtensionUI: () => Effect.void,
			});
			const envelope = JSON.stringify(restored.diagnostics);
			assert.notInclude(envelope, "raw secret");
			assert.notInclude(envelope, "alice");
			assert.notInclude(envelope, "private");
			assert.match(restored.diagnostics[0]?.packageName ?? "", /^sha256:/);
		}),
	);

	it.effect("keeps explicit empty package intent distinct from a missing-store cold boot", () =>
		Effect.gen(function* () {
			for (const testCase of [
				{
					store: makeMemoryWorkspaceStateStore(emptyWorkspaceState()),
					expected: [] as ReadonlyArray<string>,
				},
				{
					store: makeMemoryWorkspaceStateStore(),
					expected: ["a-package", "b-package"] as ReadonlyArray<string>,
				},
			]) {
				let applied: ReadonlyArray<string> = ["not-restored"];
				const restored = yield* restoreWorkspace({
					store: testCase.store,
					discover: () => Effect.succeed({_tag: "empty" as const, sessions: []}),
					restoreLineage: () => Effect.void,
					restoreSelection: () => Effect.succeed(false),
					restoreSettings: () => Effect.void,
					availablePackageRegistrations: ["b-package", "a-package"],
					restorePackageRegistrations: (packages) =>
						Effect.sync(() => {
							applied = [...packages];
						}),
					restoreExtensionUI: () => Effect.void,
				});
				assert.deepStrictEqual(applied, testCase.expected);
				assert.deepStrictEqual(restored.packageRegistrations, testCase.expected);
			}
		}),
	);

	it.effect("degrades a corrupt persistence source without suppressing later restoration", () =>
		Effect.gen(function* () {
			const stages: Array<string> = [];
			const restored = yield* restoreWorkspace({
				store: {
					load: () =>
						Effect.fail(
							new WorkspaceStateStoreError({
								operation: "load",
								message: "Workspace state is not valid JSON",
							}),
						),
					save: () => Effect.succeed({_tag: "durable" as const}),
				},
				discover: () =>
					Effect.sync(() => void stages.push("discovery")).pipe(Effect.as(discovered)),
				restoreLineage: () => Effect.sync(() => void stages.push("lineage")),
				restoreSelection: () => Effect.succeed(true),
				restoreSettings: () => Effect.sync(() => void stages.push("settings")),
				availablePackageRegistrations: [],
				restorePackageRegistrations: () => Effect.sync(() => void stages.push("packages")),
				restoreExtensionUI: () => Effect.sync(() => void stages.push("ui")),
			});
			assert.deepStrictEqual(stages, ["discovery", "lineage", "settings", "packages", "ui"]);
			assert.isTrue(
				restored.diagnostics.some(
					(diagnostic) =>
						diagnostic.category === "persistence" &&
						diagnostic.code === "workspace-state-unavailable",
				),
			);
		}),
	);

	it.effect("reports only applied settings when persisted values are unsupported", () =>
		Effect.gen(function* () {
			const restored = yield* restoreWorkspace({
				store: makeMemoryWorkspaceStateStore({
					...persisted,
					settings: {unsupportedSetting: "private-value"},
				}),
				discover: () => Effect.succeed(discovered),
				restoreLineage: () => Effect.void,
				restoreSelection: () => Effect.succeed(true),
				restoreSettings: () =>
					Effect.fail(
						new WorkspaceSettingsRestoreError({
							code: "restore-failed",
							message: "unsupported settings",
						}),
					),
				readSettings: () => Effect.succeed({theme: "system"}),
				availablePackageRegistrations: ["available-package"],
				restorePackageRegistrations: () => Effect.void,
				restoreExtensionUI: () => Effect.void,
			});
			assert.deepStrictEqual(restored.settings, {theme: "system"});
			assert.deepInclude(
				restored.diagnostics.find(({code}) => code === "settings-restore-failed"),
				{category: "persistence", code: "settings-restore-failed"},
			);
		}),
	);

	it.effect(
		"restores only current extension UI state and never replays dialogs or notifications",
		() =>
			Effect.gen(function* () {
				const bridge = makeExtensionUI();
				yield* bridge.restore(persisted.extensionUI);
				const events: Array<string> = [];
				const unsubscribe = yield* bridge.subscribe((event) => events.push(event._tag));
				assert.deepStrictEqual(events, ["status", "widget"]);
				assert.notInclude(events, "request");
				assert.notInclude(events, "notify");
				assert.notInclude(events, "settled");
				unsubscribe();
			}),
	);

	it("redacts secrets and machine-local paths while retaining actionable categories", () => {
		const redacted = redactDiagnosticText(
			String.raw`failed /Users/alice/.pi/session.jsonl /Users/Alice Doe/private.sock ~/secret/file file:///Users/alice/private "C:\\Users\\Alice Doe\\secret.txt" \\\\server\\private share\\secret.txt token="super secret suffix" Authorization: Bearer abc.def prompt='private words' transcript=private-history`,
		);
		assert.notInclude(redacted, "alice");
		assert.notInclude(redacted, "super secret suffix");
		assert.notInclude(redacted, "Alice Doe");
		assert.notInclude(redacted, "Doe/private.sock");
		assert.notInclude(redacted, "server");
		assert.notInclude(redacted, "private share");
		assert.notInclude(redacted, "abc.def");
		assert.notInclude(redacted, "private words");
		assert.notInclude(redacted, "private-history");
		assert.include(redacted, "[local-path]");
		assert.include(redacted, "[redacted]");
		const jsonRedacted = redactDiagnosticText(
			JSON.stringify({
				payload: {
					apiToken: "nested-token",
					prompt: {parts: ["private", "words"]},
					transcript: [{role: "user", content: "history"}],
				},
				message: "safe category",
			}),
		);
		assert.notInclude(jsonRedacted, "nested-token");
		assert.notInclude(jsonRedacted, "private");
		assert.notInclude(jsonRedacted, "history");
		assert.include(jsonRedacted, "safe category");
		const malicious = resilienceDiagnostic({
			category: "package",
			code: "package-registration-unavailable",
			message: String.raw`prompt="raw public prompt" at C:\\Users\\Alice Doe\\transcript.txt`,
			action: "token='raw action token'",
			sessionId: "session correlation prompt=raw",
			packageName: "package token=private",
			sourceId: "file:///Users/alice/source.jsonl",
		});
		assert.notInclude(JSON.stringify(malicious), "raw");
		assert.notInclude(JSON.stringify(malicious), "Alice");
		assert.notInclude(JSON.stringify(malicious), "alice");
		assert.match(malicious.sessionId ?? "", /^sha256:/);
		assert.match(malicious.packageName ?? "", /^sha256:/);
		assert.match(malicious.sourceId ?? "", /^sha256:/);
		const correlations = resilienceDiagnostic({
			category: "package",
			code: "package-registration-unavailable",
			message: "Registration unavailable",
			action: "Reinstall the package",
			sessionId: "/Users/alice/session",
			packageName: "token=private",
		});
		assert.match(correlations.sessionId ?? "", /^sha256:/);
		assert.match(correlations.packageName ?? "", /^sha256:/);
	});

	it("redacts canonical sensitive key tokens across JSON, assignments, and correlations", () => {
		const sensitiveKeys = [
			"access_token",
			"refreshToken",
			"OPENAI_API_KEY",
			"promptText",
			"transcript_path",
			"auth.cookie",
			"session-credential",
			"Authorization",
			"authorisation",
			"bearerToken",
			"password.value",
			"clientSecret",
		] as const;
		for (const key of sensitiveKeys) {
			const text = redactDiagnosticText(`${key}="quoted private words"`);
			assert.notInclude(text, "quoted private words", key);
			assert.include(text, "[redacted]", key);
			const json = redactDiagnosticText(JSON.stringify({[key]: "json private words"}));
			assert.notInclude(json, "json private words", key);
			const diagnostic = resilienceDiagnostic({
				category: "protocol",
				code: "reconnect-exhausted",
				message: "Reconnect failed",
				action: "Retry",
				sourceId: key,
			});
			assert.match(diagnostic.sourceId ?? "", /^sha256:/, key);
		}

		for (const key of [
			"tokenizer",
			"promptly",
			"transcription",
			"cookiecutter",
			"credentialed",
			"bearerly",
			"secretary",
			"passwordless",
		]) {
			assert.strictEqual(
				redactDiagnosticText(`${key}="innocent quoted words"`),
				`${key}="innocent quoted words"`,
			);
			assert.include(redactDiagnosticText(JSON.stringify({[key]: "innocent"})), "innocent");
		}
	});

	it("redacts separator and case variants without substring overmatching", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("token", "prompt", "transcript", "cookie", "credential", "secret"),
				fc.constantFrom("_", "-", ".", "/", ":", "@"),
				fc.constantFrom("access", "refresh", "session", "system", "client"),
				(sensitive, separator, prefix) => {
					const key = `${prefix}${separator}${sensitive.toUpperCase()}`;
					const privateValue = `private quoted ${prefix}`;
					assert.notInclude(redactDiagnosticText(`${key}="${privateValue}"`), privateValue);
					assert.notInclude(
						redactDiagnosticText(JSON.stringify({[key]: privateValue})),
						privateValue,
					);
				},
			),
		);
	});

	it("reports a committed state with a durability warning after directory sync refusal", () => {
		const result = workspaceStateDirectorySyncResult(false);
		assert.strictEqual(result._tag, "committed-with-warning");
		if (result._tag !== "committed-with-warning") return;
		assert.strictEqual(result.diagnostic.category, "persistence");
		assert.strictEqual(result.diagnostic.code, "workspace-state-directory-sync-failed");
	});

	it.layer(NodeServices.layer)((it) => {
		it.effect("keeps the renamed checkpoint committed when directory sync is refused", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-sync-warning-"});
				const statePath = path.join(root, "workspace-state.json");
				const store = yield* makeFileWorkspaceStateStore(statePath, {
					syncDirectory: () =>
						Effect.fail(
							new WorkspaceStateStoreError({
								operation: "save",
								message: "directory sync refused",
							}),
						),
				});
				const result = yield* store.save(persisted);
				assert.strictEqual(result._tag, "committed-with-warning");
				if (result._tag !== "committed-with-warning") return;
				assert.strictEqual(result.diagnostic.code, "workspace-state-directory-sync-failed");
				assert.deepStrictEqual((yield* store.load()).document, persisted);
			}),
		);

		it.effect("syncs a newly created state directory parent before committing with a warning", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-parent-sync-"});
				const directory = path.join(root, "state");
				const synced: Array<string> = [];
				const store = yield* makeFileWorkspaceStateStore(path.join(directory, "workspace.json"), {
					syncDirectory: (target) =>
						Effect.sync(() => void synced.push(target)).pipe(
							Effect.andThen(
								target === root
									? Effect.fail(
											new WorkspaceStateStoreError({
												operation: "save",
												message: "parent sync refused",
											}),
										)
									: Effect.void,
							),
						),
				});
				const result = yield* store.save(persisted);
				assert.strictEqual(result._tag, "committed-with-warning");
				assert.deepStrictEqual(synced, [root, directory]);
				assert.deepStrictEqual((yield* store.load()).document, persisted);
			}),
		);

		it.effect("keeps valid package and extension array members beside corrupt siblings", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-member-decode-"});
				const statePath = path.join(root, "workspace-state.json");
				yield* fs.writeFileString(
					statePath,
					JSON.stringify({
						...persisted,
						packageRegistrations: ["available-package", 42, "second-valid"],
						extensionUI: [persisted.extensionUI[0], {scope: {packageName: "broken"}}],
					}),
				);
				const loaded = yield* (yield* makeFileWorkspaceStateStore(statePath)).load();
				assert.deepStrictEqual(loaded.document.packageRegistrations, [
					"available-package",
					"second-valid",
				]);
				assert.deepStrictEqual(loaded.document.extensionUI, persisted.extensionUI);
				assert.isTrue(
					loaded.diagnostics.some(({code}) => code === "package-registrations-invalid"),
				);
				assert.isTrue(loaded.diagnostics.some(({code}) => code === "extension-ui-current-invalid"));
			}),
		);

		it.effect("decodes persistence domains independently with typed diagnostics", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-resilience-"});
				const statePath = path.join(root, "workspace-state.json");
				const cases = [
					{
						key: "selectedSessionId",
						value: 42,
						code: "selected-session-state-invalid",
						category: "persistence",
					},
					{
						key: "settings",
						value: ["not", "settings"],
						code: "workspace-settings-invalid",
						category: "persistence",
					},
					{
						key: "packageRegistrations",
						value: ["valid", 42],
						code: "package-registrations-invalid",
						category: "package",
					},
					{
						key: "extensionUI",
						value: [{scope: {packageName: "broken"}}],
						code: "extension-ui-current-invalid",
						category: "ui-bridge",
					},
				] as const;
				for (const testCase of cases) {
					const raw: Record<string, unknown> = structuredClone(persisted);
					raw[testCase.key] = testCase.value;
					yield* fs.writeFileString(statePath, JSON.stringify(raw));
					const store = yield* makeFileWorkspaceStateStore(statePath);
					const loaded = yield* store.load();
					if (testCase.key !== "settings") {
						assert.deepInclude(loaded.document.settings, {theme: "dark"});
					}
					if (testCase.key !== "selectedSessionId") {
						assert.strictEqual(loaded.document.selectedSessionId, "session-one");
					}
					if (testCase.key !== "packageRegistrations") {
						assert.include(loaded.document.packageRegistrations, "available-package");
					}
					if (testCase.key !== "extensionUI") {
						assert.strictEqual(loaded.document.extensionUI[0]?.scope.sessionId, "session-one");
					}
					assert.deepInclude(loaded.diagnostics[0], {
						code: testCase.code,
						category: testCase.category,
					});
				}
			}),
		);
	});

	it.effect(
		"uses Clock/Schedule bounded exponential backoff and stops after the configured retries",
		() =>
			Effect.gen(function* () {
				let attempts = 0;
				const connecting = connectLiveSessionWithBackoff(
					Effect.suspend(() => {
						attempts += 1;
						return attempts === 3 ? Effect.succeed("connected") : Effect.fail("offline");
					}),
					{retries: 2, baseDelayMs: 100, maxDelayMs: 150},
				);
				const fiber = yield* Effect.forkChild(connecting);
				yield* Effect.yieldNow;
				assert.strictEqual(attempts, 1);
				yield* TestClock.adjust("99 millis");
				assert.strictEqual(attempts, 1);
				yield* TestClock.adjust("1 millis");
				assert.strictEqual(attempts, 2);
				yield* TestClock.adjust("150 millis");
				assert.strictEqual(yield* Fiber.join(fiber), "connected");
				assert.strictEqual(attempts, 3);
			}).pipe(Effect.provide(TestClock.layer())),
	);
});
