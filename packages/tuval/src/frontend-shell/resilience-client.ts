import {Option, Schema} from "effect";
import {ExtensionUISnapshot} from "../shared/extension-ui.js";
import {
	ResilienceDiagnostic,
	type ResilienceDiagnostic as ResilienceDiagnosticValue,
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

const safeDiagnostic = (
	component: "snapshot" | "selection" | "settings" | "package" | "extension-ui" | "diagnostics",
): ResilienceDiagnosticValue => {
	if (component === "selection") {
		return {
			category: "persistence",
			code: "selected-session-state-invalid",
			message: "Kalıcı seçili oturum bilgisi okunamadı.",
			action: "Kullanılabilir bir oturumu yeniden seç.",
		};
	}
	if (component === "settings") {
		return {
			category: "persistence",
			code: "workspace-settings-invalid",
			message: "Kalıcı çalışma alanı ayarları okunamadı.",
			action: "Ayarları gözden geçir; sağlıklı çalışma alanı verileri korundu.",
		};
	}
	if (component === "package") {
		return {
			category: "package",
			code: "package-registrations-invalid",
			message: "Kalıcı paket kayıtlarının bir bölümü okunamadı.",
			action: "Paket kayıtlarını gözden geçir; geçerli kayıtlar korundu.",
		};
	}
	if (component === "extension-ui") {
		return {
			category: "ui-bridge",
			code: "extension-ui-current-invalid",
			message: "Kalıcı Extension UI durumunun bir bölümü okunamadı.",
			action: "Extension UI kaynağını gözden geçir; geçerli durum korundu.",
		};
	}
	return {
		category: "startup",
		code: "workspace-state-unavailable",
		message:
			component === "diagnostics"
				? "Geri yükleme tanılarının bir bölümü okunamadı."
				: "Geri yükleme aşamalarının bir bölümü okunamadı.",
		action: "Kalıcı çalışma alanı kaynağını gözden geçir; geçerli bölümler korundu.",
	};
};

const decodeItems = <A>(
	value: unknown,
	decode: (candidate: unknown) => A | undefined,
): {readonly values: ReadonlyArray<A>; readonly invalid: boolean} => {
	if (!Array.isArray(value)) return {values: [], invalid: true};
	const decoded = value.map(decode);
	return {
		values: decoded.filter((candidate): candidate is A => candidate !== undefined),
		invalid: decoded.some((candidate) => candidate === undefined),
	};
};

export const decodeRestorationSnapshot = (value: unknown): RestorationSnapshot | undefined => {
	if (!isRecord(value)) return undefined;

	const decodedStages = decodeItems(value.stages, decodeStage);
	const settings = decodeStringRecord(value.settings);
	const packageRegistrations = decodeItems(value.packageRegistrations, (candidate) =>
		typeof candidate === "string" ? candidate : undefined,
	);
	const extensionUI = decodeItems(value.extensionUI, (candidate) =>
		Option.getOrUndefined(Schema.decodeUnknownOption(ExtensionUISnapshot)(candidate)),
	);
	const diagnostics = decodeItems(value.diagnostics, (candidate) =>
		Option.getOrUndefined(Schema.decodeUnknownOption(ResilienceDiagnostic)(candidate)),
	);
	const selectedSessionId =
		value.selectedSessionId === null || typeof value.selectedSessionId === "string"
			? value.selectedSessionId
			: null;
	const safeDiagnostics: Array<ResilienceDiagnosticValue> = [];
	if (decodedStages.invalid) safeDiagnostics.push(safeDiagnostic("snapshot"));
	if (!(value.selectedSessionId === null || typeof value.selectedSessionId === "string")) {
		safeDiagnostics.push(safeDiagnostic("selection"));
	}
	if (settings === undefined) safeDiagnostics.push(safeDiagnostic("settings"));
	if (packageRegistrations.invalid) safeDiagnostics.push(safeDiagnostic("package"));
	if (extensionUI.invalid) safeDiagnostics.push(safeDiagnostic("extension-ui"));
	if (diagnostics.invalid) safeDiagnostics.push(safeDiagnostic("diagnostics"));

	return {
		stages: decodedStages.values,
		selectedSessionId,
		settings: settings ?? {},
		packageRegistrations: packageRegistrations.values,
		extensionUI: extensionUI.values,
		diagnostics: [...diagnostics.values, ...safeDiagnostics],
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
