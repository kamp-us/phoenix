/**
 * `patch-guard` pure core — decide whether every maintained `pnpm patch` (ADR 0038)
 * carries at least one registered behavior-pinning test, and that no pin marker is
 * stale. IO-free and total: every decision is a deterministic transform over
 * already-gathered facts (the `patchedDependencies` set + the discovered
 * `@patch-pin:` markers). The filesystem boundary (read the workspace file, walk the
 * test tree) lives in `gate.ts`; this module never touches disk.
 *
 * The two-layer discipline the guard enforces is defined once in
 * `.patterns/dependency-patch-behavior-pins.md` (the canonical definition site for the
 * "patch behavior-pin" vocabulary): a `pnpm patch` is a silent fork of a dependency's
 * behavior, so each patch must be pinned by a test that fails if the patched behavior
 * regresses — and that test self-registers with a `// @patch-pin: <name>@<version>`
 * marker keyed to the exact `patchedDependencies` entry. This guard is the forcing
 * function: a patch with no registered pin is a patch whose behavior nothing verifies.
 *
 * Fail-closed on zero scope (ADR 0092): if no `patchedDependencies` are found it is a
 * misconfiguration (wrong root, a moved workspace file), NOT a silent pass — the
 * verdict is a failure, never a vacuous green.
 */

/** A maintained patch, parsed from a `pnpm-workspace.yaml` `patchedDependencies` key. */
export interface PatchedDep {
	/** The normalized `name@version` key, e.g. `@nkzw/fate@1.3.1`. */
	readonly key: string;
	readonly name: string;
	readonly version: string;
}

/** A `// @patch-pin: <name>@<version>` marker discovered in a test file. */
export interface PinMarker {
	/** The normalized `name@version` the marker registers (raw token if unparseable). */
	readonly key: string;
	readonly name: string;
	/** Empty when the marker token had no parseable `@version` — a malformed, thus stale, pin. */
	readonly version: string;
	/** Repo-relative path of the test file the marker was found in. */
	readonly path: string;
}

/**
 * The guard verdict. A discriminated union so an invalid state is unrepresentable: a
 * pass never carries violations, and the two failure shapes (zero-scope vs
 * pin-violations) are distinct and each carries exactly its evidence. The
 * `pin-violations` shape is only constructed when at least one of `missing`/`stale` is
 * non-empty.
 */
export type PatchGuardVerdict =
	| {readonly pass: true; readonly patched: ReadonlyArray<string>; readonly markerCount: number}
	/** No `patchedDependencies` in scope — fail closed, never a vacuous pass (ADR 0092). */
	| {readonly pass: false; readonly reason: "zero-scope"}
	/** Patches exist but a patch has no pin, and/or a marker is stale (dep/version not patched). */
	| {
			readonly pass: false;
			readonly reason: "pin-violations";
			readonly patched: ReadonlyArray<string>;
			/** Patched deps with no matching `@patch-pin:` marker. */
			readonly missing: ReadonlyArray<PatchedDep>;
			/** Markers naming a `name@version` not in `patchedDependencies` (stale/orphan pin). */
			readonly stale: ReadonlyArray<PinMarker>;
	  };

/**
 * Split a `name@version` token into its parts, honoring a scoped name's leading `@`
 * (e.g. `@nkzw/fate@1.3.1` → `@nkzw/fate` + `1.3.1`). Returns `null` when there is no
 * separating `@` after index 0 (a bare name with no version) — the caller treats that
 * as a malformed marker, never a match.
 */
export const parsePatchKey = (token: string): {name: string; version: string} | null => {
	const at = token.lastIndexOf("@");
	if (at <= 0) return null;
	const name = token.slice(0, at);
	const version = token.slice(at + 1);
	if (name === "" || version === "") return null;
	return {name, version};
};

/**
 * Parse the `patchedDependencies:` block from a `pnpm-workspace.yaml`'s text into the
 * authoritative set of maintained patches. Minimal, dependency-free YAML slice (mirrors
 * `catalog-guard`'s `parseWorkspacePackageGlobs`): reads the block's `  <key>: <patch>`
 * mapping entries and stops at the next top-level key. Keys may be single/double quoted
 * (`'@nkzw/fate@1.3.1'`) or bare (`alchemy@2.0.0-beta.59`).
 */
export const parsePatchedDependencies = (yaml: string): ReadonlyArray<PatchedDep> => {
	const out: Array<PatchedDep> = [];
	let inBlock = false;
	for (const raw of yaml.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (/^patchedDependencies:\s*$/.test(line)) {
			inBlock = true;
			continue;
		}
		if (!inBlock) continue;
		if (/^\s*$/.test(line)) continue; // tolerate blank lines within the block
		if (/^\S/.test(line)) break; // a non-indented line is the next top-level key — block ends
		if (/^\s*#/.test(line)) continue; // tolerate a comment line
		const m = /^\s+(?:'([^']+)'|"([^"]+)"|([^:#]+?))\s*:/.exec(line);
		const token = m?.[1] ?? m?.[2] ?? m?.[3];
		if (token === undefined) continue;
		const parsed = parsePatchKey(token.trim());
		if (parsed) out.push({key: `${parsed.name}@${parsed.version}`, ...parsed});
	}
	return out;
};

// The registration marker grammar — a comment carrying `@patch-pin: <name>@<version>`.
// The grammar itself is defined in .patterns/dependency-patch-behavior-pins.md; a test
// file scanned by this guard must not embed the contiguous tag as a stray marker.
const PIN_MARKER_RE = /@patch-pin:\s*(\S+)/g;

/**
 * Extract every `@patch-pin:` marker from a file's text. A token that fails to parse
 * into `name@version` is still recorded (with an empty version) so it surfaces as a
 * stale/malformed pin rather than being silently dropped — fail-closed.
 */
export const parsePinMarkers = (source: string, path: string): ReadonlyArray<PinMarker> => {
	const out: Array<PinMarker> = [];
	for (const match of source.matchAll(PIN_MARKER_RE)) {
		const token = match[1] ?? "";
		const parsed = parsePatchKey(token);
		out.push(
			parsed
				? {key: `${parsed.name}@${parsed.version}`, ...parsed, path}
				: {key: token, name: token, version: "", path},
		);
	}
	return out;
};

/**
 * Decide the verdict over the enumerated patches and discovered markers. Fails closed
 * on zero patches (ADR 0092), else reds on any patched dep with no matching pin
 * (`missing`) or any marker whose `name@version` is not a maintained patch (`stale`).
 */
export const judge = (
	patched: ReadonlyArray<PatchedDep>,
	markers: ReadonlyArray<PinMarker>,
): PatchGuardVerdict => {
	if (patched.length === 0) {
		return {pass: false, reason: "zero-scope"};
	}
	const markerKeys = new Set(markers.map((m) => m.key));
	const patchedKeys = new Set(patched.map((p) => p.key));
	const missing = patched.filter((p) => !markerKeys.has(p.key));
	const stale = markers.filter((m) => !patchedKeys.has(m.key));
	const patchedList = patched.map((p) => p.key);
	if (missing.length > 0 || stale.length > 0) {
		return {pass: false, reason: "pin-violations", patched: patchedList, missing, stale};
	}
	return {pass: true, patched: patchedList, markerCount: markers.length};
};

/** Render the human-readable report for a verdict (ADR 0092 §1 "emit what you scanned"). */
export const renderReport = (verdict: PatchGuardVerdict): string => {
	if (verdict.pass) {
		return (
			`patch-guard: all ${verdict.patched.length} maintained patch${verdict.patched.length === 1 ? "" : "es"} ` +
			`carry a behavior pin (${verdict.markerCount} @patch-pin marker${verdict.markerCount === 1 ? "" : "s"} across the test tree): ` +
			verdict.patched.join(", ")
		);
	}
	if (verdict.reason === "zero-scope") {
		return (
			"patch-guard: found ZERO patchedDependencies in pnpm-workspace.yaml — fail-closed (ADR 0092). " +
			"Is the repo root correct, or did the workspace file move?"
		);
	}
	const lines: Array<string> = [];
	for (const dep of verdict.missing) {
		lines.push(
			`  ${dep.key}: patched but has NO \`// @patch-pin: ${dep.key}\` marker — ` +
				"a pnpm patch (ADR 0038) with no behavior-pinning test is an unverified fork. " +
				`Fix: add a test that fails if the patched behavior regresses and tag it \`// @patch-pin: ${dep.key}\` (see .patterns/dependency-patch-behavior-pins.md).`,
		);
	}
	for (const m of verdict.stale) {
		lines.push(
			`  ${m.path}: \`@patch-pin: ${m.key}\` names a dep/version NOT in patchedDependencies (stale pin) — ` +
				"the patch was dropped or its version bumped without updating the pin. " +
				"Fix: update the marker to the current patchedDependencies key, or delete the orphaned pin.",
		);
	}
	return (
		`patch-guard: ${verdict.missing.length} unpinned patch${verdict.missing.length === 1 ? "" : "es"} ` +
		`and ${verdict.stale.length} stale pin${verdict.stale.length === 1 ? "" : "s"} ` +
		`(of ${verdict.patched.length} maintained patch${verdict.patched.length === 1 ? "" : "es"}):\n${lines.join("\n")}`
	);
};
