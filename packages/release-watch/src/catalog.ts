/**
 * Read the watched pins out of `pnpm-workspace.yaml`'s root `catalog:` block. Named catalogs under
 * `catalogs:` are not the root catalog and are not read.
 */
import {parse} from "yaml";
import {type CatalogPin, WATCHED_SCOPE} from "./release-watch.ts";

export type CatalogRead =
	| {readonly _tag: "Read"; readonly pins: ReadonlyArray<CatalogPin>}
	| {readonly _tag: "Unreadable"; readonly reason: string};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const watchedPins = (workspaceYaml: string): CatalogRead => {
	let document: unknown;
	try {
		document = parse(workspaceYaml);
	} catch (cause) {
		return {_tag: "Unreadable", reason: `pnpm-workspace.yaml is not YAML: ${String(cause)}`};
	}
	if (!isRecord(document) || !isRecord(document.catalog)) {
		return {_tag: "Unreadable", reason: "pnpm-workspace.yaml has no root `catalog:` mapping"};
	}
	const pins: Array<CatalogPin> = [];
	for (const [name, spec] of Object.entries(document.catalog)) {
		if (!name.startsWith(WATCHED_SCOPE)) continue;
		if (typeof spec !== "string") {
			return {_tag: "Unreadable", reason: `catalog entry ${name} is not a version string`};
		}
		pins.push({name, spec});
	}
	return {_tag: "Read", pins};
};
