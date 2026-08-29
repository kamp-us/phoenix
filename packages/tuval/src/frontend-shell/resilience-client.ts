import {Option, Schema} from "effect";
import {ExtensionUISnapshot} from "../shared/extension-ui.js";
import {
	ResilienceDiagnostic,
	type RestorationSnapshot,
	type RestorationStage,
	type RestorationStageResult,
} from "../shared/resilience.js";

const stages = new Set<RestorationStage>([
	"discovery",
	"lineage",
	"selection",
	"settings",
	"package-registrations",
	"extension-ui-current",
]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const decodeStage = (value: unknown): RestorationStageResult | undefined => {
	if (
		!isRecord(value) ||
		typeof value.stage !== "string" ||
		!stages.has(value.stage as RestorationStage)
	) {
		return undefined;
	}
	return value.status === "restored" || value.status === "degraded"
		? {stage: value.stage as RestorationStage, status: value.status}
		: undefined;
};

const decodeStringRecord = (value: unknown): Readonly<Record<string, string>> | undefined =>
	isRecord(value) && Object.values(value).every((entry) => typeof entry === "string")
		? (value as Readonly<Record<string, string>>)
		: undefined;

export const decodeRestorationSnapshot = (value: unknown): RestorationSnapshot | undefined => {
	if (
		!isRecord(value) ||
		!Array.isArray(value.stages) ||
		!Array.isArray(value.packageRegistrations)
	) {
		return undefined;
	}
	const decodedStages = value.stages.map(decodeStage);
	const settings = decodeStringRecord(value.settings);
	const diagnostics = Option.getOrUndefined(
		Schema.decodeUnknownOption(Schema.Array(ResilienceDiagnostic))(value.diagnostics),
	);
	const extensionUI = Option.getOrUndefined(
		Schema.decodeUnknownOption(Schema.Array(ExtensionUISnapshot))(value.extensionUI),
	);
	if (
		decodedStages.some((stage) => stage === undefined) ||
		settings === undefined ||
		diagnostics === undefined ||
		extensionUI === undefined ||
		!value.packageRegistrations.every((name) => typeof name === "string") ||
		!(value.selectedSessionId === null || typeof value.selectedSessionId === "string")
	) {
		return undefined;
	}
	return {
		stages: decodedStages as ReadonlyArray<RestorationStageResult>,
		selectedSessionId: value.selectedSessionId,
		settings,
		packageRegistrations: value.packageRegistrations as ReadonlyArray<string>,
		extensionUI,
		diagnostics,
	};
};

export const readRestorationSnapshot = async (): Promise<RestorationSnapshot> => {
	const response = await fetch("/api/resilience", {
		cache: "no-store",
		credentials: "same-origin",
		headers: {accept: "application/json"},
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const snapshot = decodeRestorationSnapshot(await response.json());
	if (snapshot === undefined) throw new Error("Çalışma alanı geri yükleme özeti doğrulanamadı");
	return snapshot;
};
