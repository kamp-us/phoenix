/**
 * `patch-guard`'s pure half — does every maintained `pnpm patch` (ADR 0038) carry a registered
 * behavior-pinning test, and is no pin stale?
 *
 * The two-layer discipline this enforces is defined once in
 * [.patterns/dependency-patch-behavior-pins.md](../../../../.patterns/dependency-patch-behavior-pins.md):
 * a `pnpm patch` is a silent fork of a dependency's behavior, so each patch must be pinned by a
 * test that fails if the patched behavior regresses, and that test self-registers with a
 * `// @patch-pin: <name>@<version>` marker keyed to the exact `patchedDependencies` entry. This
 * guard is the forcing function — a patch with no registered pin is a fork nothing verifies.
 *
 * IO-free: the workspace read and the test-tree walk live in `./patch-verb.ts`.
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

/** What the cross-check found: patches with no pin, and pins naming no patch. */
export interface PinAudit {
	/** Patched deps with no matching `@patch-pin:` marker. */
	readonly missing: ReadonlyArray<PatchedDep>;
	/** Markers naming a `name@version` not in `patchedDependencies` (stale/orphan pin). */
	readonly stale: ReadonlyArray<PinMarker>;
}

/**
 * Split a `name@version` token into its parts, honoring a scoped name's leading `@`
 * (e.g. `@nkzw/fate@1.3.1` → `@nkzw/fate` + `1.3.1`). Returns `null` when there is no separating
 * `@` after index 0 — the caller treats that as a malformed marker, never a match.
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
 * The `patchedDependencies:` block of a `pnpm-workspace.yaml` as the authoritative maintained-patch
 * set. A minimal dependency-free YAML slice: read the block's `  <key>: <patch>` entries and stop at
 * the next top-level key. Keys may be quoted (`'@nkzw/fate@1.3.1'`) or bare.
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
		if (/^\s*$/.test(line)) continue;
		if (/^\S/.test(line)) break; // a non-indented line is the next top-level key — block ends
		if (/^\s*#/.test(line)) continue;
		const m = /^\s+(?:'([^']+)'|"([^"]+)"|([^:#]+?))\s*:/.exec(line);
		const token = m?.[1] ?? m?.[2] ?? m?.[3];
		if (token === undefined) continue;
		const parsed = parsePatchKey(token.trim());
		if (parsed) out.push({key: `${parsed.name}@${parsed.version}`, ...parsed});
	}
	return out;
};

// The registration marker grammar, defined in .patterns/dependency-patch-behavior-pins.md. A test
// file scanned by this guard must not embed the contiguous tag as a stray marker.
const PIN_MARKER_RE = /@patch-pin:\s*(\S+)/g;

/**
 * Every `@patch-pin:` marker in a file's text. A token that fails to parse into `name@version` is
 * still recorded (with an empty version) so it surfaces as a stale pin rather than being silently
 * dropped — fail-closed.
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

/** Cross-check the enumerated patches against the discovered markers, both directions. */
export const auditPins = (
	patched: ReadonlyArray<PatchedDep>,
	markers: ReadonlyArray<PinMarker>,
): PinAudit => {
	const markerKeys = new Set(markers.map((m) => m.key));
	const patchedKeys = new Set(patched.map((p) => p.key));
	return {
		missing: patched.filter((p) => !markerKeys.has(p.key)),
		stale: markers.filter((m) => !patchedKeys.has(m.key)),
	};
};

/** What an unpinned patch's fix is — also the annotation body on `pnpm-workspace.yaml`. */
export const missingPinFix = (key: string): string =>
	`${key}: patched but has NO \`// @patch-pin: ${key}\` marker — ` +
	"a pnpm patch (ADR 0038) with no behavior-pinning test is an unverified fork. " +
	`Fix: add a test that fails if the patched behavior regresses and tag it \`// @patch-pin: ${key}\` (see .patterns/dependency-patch-behavior-pins.md).`;

/** What a stale pin's fix is — also the annotation body on the test file carrying it. */
export const stalePinFix = (marker: PinMarker): string =>
	`${marker.path}: \`@patch-pin: ${marker.key}\` names a dep/version NOT in patchedDependencies (stale pin) — ` +
	"the patch was dropped or its version bumped without updating the pin. " +
	"Fix: update the marker to the current patchedDependencies key, or delete the orphaned pin.";

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The one-line summary of a fully pinned tree (ADR 0092 §1 "emit what you scanned"). */
export const cleanSummary = (
	verb: string,
	patched: ReadonlyArray<string>,
	markerCount: number,
): string =>
	`${verb}: all ${patched.length} maintained ${plural(patched.length, "patch", "patches")} ` +
	`carry a behavior pin (${markerCount} @patch-pin ${plural(markerCount, "marker", "markers")} across the test tree): ` +
	patched.join(", ");

/** The human report naming every unpinned patch and every stale pin, with each one's fix. */
export const pinViolationReport = (
	verb: string,
	patched: ReadonlyArray<string>,
	audit: PinAudit,
): string => {
	const lines = [
		...audit.missing.map((dep) => `  ${missingPinFix(dep.key)}`),
		...audit.stale.map((marker) => `  ${stalePinFix(marker)}`),
	];
	return (
		`${verb}: ${audit.missing.length} unpinned ${plural(audit.missing.length, "patch", "patches")} ` +
		`and ${audit.stale.length} stale ${plural(audit.stale.length, "pin", "pins")} ` +
		`(of ${patched.length} maintained ${plural(patched.length, "patch", "patches")}):\n${lines.join("\n")}`
	);
};
