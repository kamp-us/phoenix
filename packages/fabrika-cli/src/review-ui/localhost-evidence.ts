import {createHash} from "node:crypto";
import {isRecord, parseJson} from "../io/json.ts";
import type {CaptureEntry} from "./manifest.ts";

export const LOCALHOST_DECLARATIONS_PATH = ".github/review-ui-localhost-harnesses.json";
export const LOCALHOST_EVIDENCE_SCHEMA_VERSION = 1;
export const BROWSER_ERROR_TEXT_CAP = 1_024;

export interface LocalhostSurface {
	readonly id: string;
	readonly route: string;
	readonly state: string;
	readonly width: number;
	readonly height: number;
}

export interface LocalhostHarnessDeclaration {
	readonly id: string;
	readonly workflow: string;
	readonly check: string;
	readonly event: "pull_request_target";
	readonly artifact: string;
	readonly captureCommand: readonly string[];
	readonly serverCommand: readonly string[];
	readonly containerPort: number;
	readonly readinessPattern: string;
	readonly captureReadySelector: string;
	readonly surfaces: readonly LocalhostSurface[];
}

export interface LocalhostDeclarations {
	readonly schemaVersion: 1;
	readonly harnesses: readonly LocalhostHarnessDeclaration[];
}

const strings = (value: unknown): value is readonly string[] =>
	Array.isArray(value) &&
	value.length > 0 &&
	value.every((entry) => typeof entry === "string" && entry !== "");

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[a-z0-9]+(?:-[a-z0-9]+)*\.yml$/;

const toSurface = (value: unknown): LocalhostSurface | null => {
	if (!isRecord(value)) return null;
	if (
		typeof value.id !== "string" ||
		!SAFE_ID.test(value.id) ||
		typeof value.route !== "string" ||
		!value.route.startsWith("/") ||
		typeof value.state !== "string" ||
		!SAFE_ID.test(value.state) ||
		typeof value.width !== "number" ||
		typeof value.height !== "number" ||
		!Number.isInteger(value.width) ||
		!Number.isInteger(value.height) ||
		value.width <= 0 ||
		value.height <= 0
	) {
		return null;
	}
	return {
		id: value.id,
		route: value.route,
		state: value.state,
		width: value.width,
		height: value.height,
	};
};

const isRegularExpression = (value: string): boolean => {
	try {
		new RegExp(value);
		return true;
	} catch {
		return false;
	}
};

const toHarness = (value: unknown): LocalhostHarnessDeclaration | null => {
	if (!isRecord(value) || !Array.isArray(value.surfaces)) return null;
	if (
		typeof value.id !== "string" ||
		!SAFE_ID.test(value.id) ||
		typeof value.workflow !== "string" ||
		!WORKFLOW_PATH.test(value.workflow) ||
		typeof value.check !== "string" ||
		value.check === "" ||
		value.event !== "pull_request_target" ||
		typeof value.artifact !== "string" ||
		!SAFE_ID.test(value.artifact) ||
		!strings(value.captureCommand) ||
		!strings(value.serverCommand) ||
		typeof value.containerPort !== "number" ||
		!Number.isInteger(value.containerPort) ||
		value.containerPort < 1024 ||
		value.containerPort > 65535 ||
		typeof value.readinessPattern !== "string" ||
		!isRegularExpression(value.readinessPattern) ||
		typeof value.captureReadySelector !== "string" ||
		value.captureReadySelector === ""
	) {
		return null;
	}
	const surfaces = value.surfaces.map(toSurface);
	if (surfaces.length === 0 || surfaces.some((surface) => surface === null)) return null;
	const ids = surfaces.map((surface) => (surface as LocalhostSurface).id);
	if (new Set(ids).size !== ids.length) return null;
	return {
		id: value.id,
		workflow: value.workflow,
		check: value.check,
		event: value.event,
		artifact: value.artifact,
		captureCommand: value.captureCommand,
		serverCommand: value.serverCommand,
		containerPort: value.containerPort,
		readinessPattern: value.readinessPattern,
		captureReadySelector: value.captureReadySelector,
		surfaces: surfaces as readonly LocalhostSurface[],
	};
};

export type DeclarationRead =
	| {readonly _tag: "Declarations"; readonly value: LocalhostDeclarations}
	| {readonly _tag: "Malformed"; readonly reason: string};

export const parseLocalhostDeclarations = (text: string): DeclarationRead => {
	const parsed = parseJson(text);
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== LOCALHOST_EVIDENCE_SCHEMA_VERSION ||
		!Array.isArray(parsed.harnesses)
	) {
		return {_tag: "Malformed", reason: "expected schemaVersion 1 and a harnesses array"};
	}
	const harnesses = parsed.harnesses.map(toHarness);
	if (harnesses.length === 0 || harnesses.some((harness) => harness === null)) {
		return {
			_tag: "Malformed",
			reason: "the declaration must contain only complete harness records",
		};
	}
	const ids = harnesses.map((harness) => (harness as LocalhostHarnessDeclaration).id);
	if (new Set(ids).size !== ids.length) {
		return {_tag: "Malformed", reason: "two localhost harness declarations use the same id"};
	}
	return {
		_tag: "Declarations",
		value: {schemaVersion: 1, harnesses: harnesses as readonly LocalhostHarnessDeclaration[]},
	};
};

export const declarationDigest = (text: string): string =>
	createHash("sha256").update(text).digest("hex");

export interface CiProducerIdentity {
	readonly workflow: string;
	readonly check: string;
	readonly event: "pull_request_target";
	readonly runId: number;
	readonly artifact: string;
	readonly authorityHead: string;
}

export const CI_PROVENANCE_RECEIPT = "validated-provenance.json";

export interface ValidatedCiProvenance {
	readonly schemaVersion: 1;
	readonly repository: string;
	readonly pr: number;
	readonly head: string;
	readonly harness: string;
	readonly runId: number;
	readonly checkId: number;
	readonly artifactId: number;
	readonly manifestSha256: string;
}

export const parseValidatedCiProvenance = (text: string): ValidatedCiProvenance | null => {
	const value = parseJson(text);
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		typeof value.repository !== "string" ||
		typeof value.pr !== "number" ||
		typeof value.head !== "string" ||
		!FULL_SHA.test(value.head) ||
		typeof value.harness !== "string" ||
		typeof value.runId !== "number" ||
		!Number.isInteger(value.runId) ||
		value.runId <= 0 ||
		typeof value.checkId !== "number" ||
		!Number.isInteger(value.checkId) ||
		value.checkId <= 0 ||
		typeof value.artifactId !== "number" ||
		!Number.isInteger(value.artifactId) ||
		value.artifactId <= 0 ||
		typeof value.manifestSha256 !== "string" ||
		!SHA256.test(value.manifestSha256)
	) {
		return null;
	}
	return {
		schemaVersion: 1,
		repository: value.repository,
		pr: value.pr,
		head: value.head,
		harness: value.harness,
		runId: value.runId,
		checkId: value.checkId,
		artifactId: value.artifactId,
		manifestSha256: value.manifestSha256,
	};
};

export interface CiCaptureEntry extends CaptureEntry {
	readonly route: string;
	readonly state: string;
	readonly errorCoverage: {
		readonly pageerror: "readable";
		readonly consoleError: "readable";
	};
}

export interface CiCaptureManifest {
	readonly schemaVersion: 1;
	readonly source: "github-actions";
	readonly repository: string;
	readonly pr: number;
	readonly head: string;
	readonly harness: string;
	readonly declarationSha256: string;
	readonly producer: CiProducerIdentity;
	readonly captures: readonly CiCaptureEntry[];
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RELATIVE_CAPTURE = /^captures\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.png$/;

const toCiEntry = (value: unknown): CiCaptureEntry | null => {
	if (!isRecord(value) || !isRecord(value.pageErrors) || !isRecord(value.errorCoverage))
		return null;
	if (
		typeof value.surface !== "string" ||
		typeof value.route !== "string" ||
		!value.route.startsWith("/") ||
		typeof value.state !== "string" ||
		!SAFE_ID.test(value.state) ||
		typeof value.path !== "string" ||
		!RELATIVE_CAPTURE.test(value.path) ||
		typeof value.width !== "number" ||
		typeof value.height !== "number" ||
		!Number.isInteger(value.width) ||
		!Number.isInteger(value.height) ||
		value.width <= 0 ||
		value.height <= 0 ||
		typeof value.sha256 !== "string" ||
		!SHA256.test(value.sha256) ||
		!Array.isArray(value.pageErrors.rows) ||
		typeof value.pageErrors.more !== "number" ||
		!Number.isInteger(value.pageErrors.more) ||
		value.pageErrors.more < 0 ||
		value.errorCoverage.pageerror !== "readable" ||
		value.errorCoverage.consoleError !== "readable"
	) {
		return null;
	}
	const rows = value.pageErrors.rows;
	if (
		rows.length > 3 ||
		!rows.every(
			(row) =>
				isRecord(row) &&
				(row.kind === "pageerror" || row.kind === "console.error") &&
				typeof row.text === "string" &&
				row.text.length <= BROWSER_ERROR_TEXT_CAP,
		)
	) {
		return null;
	}
	return {
		surface: value.surface,
		route: value.route,
		state: value.state,
		path: value.path,
		width: value.width,
		height: value.height,
		sha256: value.sha256,
		pageErrors: {
			rows: rows as CaptureEntry["pageErrors"]["rows"],
			more: value.pageErrors.more,
		},
		errorCoverage: {pageerror: "readable", consoleError: "readable"},
	};
};

export type CiManifestRead =
	| {readonly _tag: "Manifest"; readonly value: CiCaptureManifest}
	| {readonly _tag: "Malformed"; readonly reason: string};

export const parseCiCaptureManifest = (text: string): CiManifestRead => {
	const parsed = parseJson(text);
	if (!isRecord(parsed) || !isRecord(parsed.producer) || !Array.isArray(parsed.captures)) {
		return {_tag: "Malformed", reason: "not a complete CI capture manifest"};
	}
	if (
		parsed.schemaVersion !== LOCALHOST_EVIDENCE_SCHEMA_VERSION ||
		parsed.source !== "github-actions" ||
		typeof parsed.repository !== "string" ||
		typeof parsed.pr !== "number" ||
		!Number.isInteger(parsed.pr) ||
		parsed.pr <= 0 ||
		typeof parsed.head !== "string" ||
		!FULL_SHA.test(parsed.head) ||
		typeof parsed.harness !== "string" ||
		typeof parsed.declarationSha256 !== "string" ||
		!SHA256.test(parsed.declarationSha256) ||
		typeof parsed.producer.workflow !== "string" ||
		typeof parsed.producer.check !== "string" ||
		parsed.producer.event !== "pull_request_target" ||
		typeof parsed.producer.runId !== "number" ||
		!Number.isInteger(parsed.producer.runId) ||
		parsed.producer.runId <= 0 ||
		typeof parsed.producer.artifact !== "string" ||
		typeof parsed.producer.authorityHead !== "string" ||
		!FULL_SHA.test(parsed.producer.authorityHead)
	) {
		return {_tag: "Malformed", reason: "the CI provenance is incomplete or off vocabulary"};
	}
	const captures = parsed.captures.map(toCiEntry);
	if (captures.length === 0 || captures.some((capture) => capture === null)) {
		return {_tag: "Malformed", reason: "the CI manifest contains a malformed or empty capture set"};
	}
	const paths = captures.map((capture) => (capture as CiCaptureEntry).path);
	if (new Set(paths).size !== paths.length) {
		return {_tag: "Malformed", reason: "two captures name the same artifact member"};
	}
	const surfaces = captures.map((capture) => (capture as CiCaptureEntry).surface);
	if (new Set(surfaces).size !== surfaces.length) {
		return {_tag: "Malformed", reason: "two captures name the same surface"};
	}
	return {
		_tag: "Manifest",
		value: {
			schemaVersion: 1,
			source: "github-actions",
			repository: parsed.repository,
			pr: parsed.pr,
			head: parsed.head,
			harness: parsed.harness,
			declarationSha256: parsed.declarationSha256,
			producer: {
				workflow: parsed.producer.workflow,
				check: parsed.producer.check,
				event: "pull_request_target",
				runId: parsed.producer.runId,
				artifact: parsed.producer.artifact,
				authorityHead: parsed.producer.authorityHead,
			},
			captures: captures as readonly CiCaptureEntry[],
		},
	};
};
