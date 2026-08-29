import * as Schema from "effect/Schema";
import {ExtensionUISnapshot} from "./extension-ui.js";

export const ResilienceDiagnosticCategory = Schema.Literals([
	"startup",
	"protocol",
	"lineage",
	"persistence",
	"package",
	"ui-bridge",
]);
export type ResilienceDiagnosticCategory = (typeof ResilienceDiagnosticCategory)["Type"];

export const ResilienceDiagnosticCode = Schema.Literals([
	"workspace-state-unavailable",
	"workspace-state-save-failed",
	"selected-session-state-invalid",
	"workspace-settings-invalid",
	"package-registrations-invalid",
	"extension-ui-current-invalid",
	"discovery-fatal",
	"discovery-transport",
	"discovery-failed",
	"discovery-source-unavailable",
	"lineage-restore-failed",
	"selected-session-unavailable",
	"selected-lease-unavailable",
	"settings-restore-failed",
	"package-registration-unavailable",
	"package-registration-restore-failed",
	"extension-ui-current-restore-failed",
	"live-session-protocol-degraded",
	"reconnect-exhausted",
	"package-root-unavailable",
	"package-manifest-unreadable",
	"package-manifest-invalid-json",
	"package-name-invalid",
	"manifest-invalid",
	"backend-module-unavailable",
	"backend-export-not-factory",
	"backend-export-not-layer",
	"backend-layer-build-failed",
	"duplicate-key",
	"shadowed-key",
	"asset-unavailable",
]);
export type ResilienceDiagnosticCode = (typeof ResilienceDiagnosticCode)["Type"];

export const ResilienceDiagnostic = Schema.Struct({
	category: ResilienceDiagnosticCategory,
	code: ResilienceDiagnosticCode,
	message: Schema.String,
	action: Schema.String,
	sessionId: Schema.optionalKey(Schema.String),
	packageName: Schema.optionalKey(Schema.String),
});
export type ResilienceDiagnostic = (typeof ResilienceDiagnostic)["Type"];

export const WorkspaceSettings = Schema.Record(Schema.String, Schema.String);
export type WorkspaceSettings = (typeof WorkspaceSettings)["Type"];

export const WorkspaceStateDocument = Schema.Struct({
	version: Schema.Literal(1),
	selectedSessionId: Schema.NullOr(Schema.String),
	settings: WorkspaceSettings,
	packageRegistrations: Schema.Array(Schema.String),
	extensionUI: Schema.Array(ExtensionUISnapshot),
});
export type WorkspaceStateDocument = (typeof WorkspaceStateDocument)["Type"];

export const emptyWorkspaceState = (): WorkspaceStateDocument => ({
	version: 1,
	selectedSessionId: null,
	settings: {},
	packageRegistrations: [],
	extensionUI: [],
});

export const RestorationStage = Schema.Literals([
	"discovery",
	"lineage",
	"selection",
	"settings",
	"package-registrations",
	"extension-ui-current",
]);
export type RestorationStage = (typeof RestorationStage)["Type"];

export interface RestorationStageResult {
	readonly stage: RestorationStage;
	readonly status: "restored" | "degraded";
}

export interface RestorationSnapshot {
	readonly stages: ReadonlyArray<RestorationStageResult>;
	readonly selectedSessionId: string | null;
	readonly settings: WorkspaceSettings;
	readonly packageRegistrations: ReadonlyArray<string>;
	readonly extensionUI: ReadonlyArray<ExtensionUISnapshot>;
	readonly diagnostics: ReadonlyArray<ResilienceDiagnostic>;
}
