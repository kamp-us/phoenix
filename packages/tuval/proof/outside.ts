/**
 * The decision core of the outside-author proof (#9654): an example program, copied out of the
 * checkout, installs the packed SDK with npm, type-checks and passes its `testProgram` test. The bin
 * in `outside.bin.ts` runs those steps; this module judges what they read. Every path it is handed
 * has already been canonicalised by the bin, so a `/var` and `/private/var` spelling of one file
 * compare equal.
 */
import {isAbsolute, relative} from "node:path";
import {fileURLToPath} from "node:url";

export type Phase = "typecheck" | "test";

const within = (root: string, path: string): boolean => {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Where the example is about to run. Under the checkout, Node and tsc would walk up into it. */
export type Placement =
	| {readonly _tag: "Outside"}
	| {readonly _tag: "Inside"; readonly path: string};

export const placement = (checkout: string, work: string): Placement =>
	within(checkout, work) ? {_tag: "Inside", path: work} : {_tag: "Outside"};

/** The files `tsc --listFiles` printed, one per line. */
export const listedFiles = (stdout: string): ReadonlyArray<string> =>
	stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");

/** The files the resolve hook logged; `node:` builtins and other schemes name no file. */
export const resolvedFiles = (log: string): ReadonlyArray<string> => [
	...new Set(
		log
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("file:"))
			.map((url) => fileURLToPath(url)),
	),
];

/**
 * The effect version the packed SDK pins. The example installs that exact version beside it, as the
 * SDK's README tells an author to, so the example's schemas and the SDK's share one copy.
 */
export const effectPin = (packedManifest: string): string => {
	const manifest = JSON.parse(packedManifest) as {dependencies?: Record<string, string>};
	const pin = manifest.dependencies?.effect;
	if (pin === undefined || !/^\d/.test(pin)) {
		throw new Error(`the packed manifest pins no published effect version (found ${String(pin)})`);
	}
	return pin;
};

export interface Offender {
	readonly phase: Phase;
	readonly path: string;
}

export type Verdict =
	| {readonly _tag: "Clean"; readonly typecheck: number; readonly test: number}
	| {readonly _tag: "Leaked"; readonly offenders: ReadonlyArray<Offender>}
	/** The phase read no file of the installed SDK, so it proves nothing about where the SDK came from. */
	| {readonly _tag: "Unobserved"; readonly phase: Phase};

const INSTALLED_SDK = "/node_modules/@kampus/tuval-sdk/";

export const judge = (
	checkout: string,
	read: {readonly [phase in Phase]: ReadonlyArray<string>},
): Verdict => {
	const phases: ReadonlyArray<Phase> = ["typecheck", "test"];
	const offenders = phases.flatMap((phase) =>
		read[phase].filter((path) => within(checkout, path)).map((path) => ({phase, path})),
	);
	if (offenders.length > 0) return {_tag: "Leaked", offenders};
	const blind = phases.find((phase) => !read[phase].some((path) => path.includes(INSTALLED_SDK)));
	if (blind !== undefined) return {_tag: "Unobserved", phase: blind};
	return {_tag: "Clean", typecheck: read.typecheck.length, test: read.test.length};
};

export const render = (verdict: Verdict): string => {
	switch (verdict._tag) {
		case "Clean":
			return `outside proof: clean — typecheck read ${verdict.typecheck} files and the test run resolved ${verdict.test}, none inside the checkout.`;
		case "Leaked":
			return [
				"outside proof: the example resolved files inside the phoenix checkout:",
				...verdict.offenders.map((o) => `  ${o.phase} resolved ${o.path}`),
			].join("\n");
		case "Unobserved":
			return `outside proof: the ${verdict.phase} phase read no file of the installed @kampus/tuval-sdk, so it proves nothing.`;
	}
};
