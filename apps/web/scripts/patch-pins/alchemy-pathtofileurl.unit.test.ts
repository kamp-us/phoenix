// @patch-pin: alchemy@2.0.0-beta.59
/**
 * Behavior pin for the `pathToFileURL` hunk of
 * `patches/alchemy@2.0.0-beta.59.patch` (bin/exec.js `importStack`, ADR 0038,
 * #2634).
 *
 * The patch derives the ESM import URL as `pathToFileURL(resolve(main)).href`
 * instead of the upstream `import.meta.resolve(resolve(main))`. On Windows,
 * `resolve(main)` is a drive-lettered absolute path (`C:\...`); feeding that
 * straight into URL resolution parses the drive letter as a URL *scheme*
 * (`c:`), and `import()` rejects the resulting `c:`-scheme specifier.
 * `pathToFileURL` instead escapes it to a valid `file:///C:/...` URL the ESM
 * loader accepts (and is byte-identical to the upstream output on POSIX).
 *
 * These assertions run on POSIX CI: `pathToFileURL`'s `{windows: true}` option
 * (Node ≥22.1; repo pins node 26.2.0) reproduces the Windows derivation
 * deterministically regardless of host OS, so the pinned contract is the
 * `file:///C:/...` shape from a Windows-style input path — no coupling to the
 * loader/OS-sensitive `import.meta.resolve` counterpart.
 */
import path from "node:path";
import {pathToFileURL} from "node:url";
import {describe, expect, it} from "vitest";

// Mirrors the patched derivation in alchemy's bin/exec.js `importStack`.
const patchedDerivation = (main: string): string =>
	pathToFileURL(path.win32.resolve(main), {windows: true}).href;

const WIN_MAIN = "C:\\Users\\ci\\proj\\alchemy.run.ts";

describe("alchemy patch — importStack pathToFileURL derivation", () => {
	it("derives a valid file:// URL from a Windows absolute path", () => {
		const url = new URL(patchedDerivation(WIN_MAIN));
		// The drive letter survives as a path segment, not a URL scheme.
		expect(url.protocol).toBe("file:");
		expect(url.href).toBe("file:///C:/Users/ci/proj/alchemy.run.ts");
	});

	it("diverges from the broken derivation that parses the drive letter as a scheme", () => {
		// ILLUSTRATIVE (not the upstream `import.meta.resolve`, which is
		// loader/OS-sensitive): URL-resolving the raw Windows absolute path reads
		// `C:` as the scheme — exactly the `c:`-scheme specifier `import()` rejects,
		// and precisely what the patch exists to avoid.
		const brokenScheme = new URL(path.win32.resolve(WIN_MAIN)).protocol;
		expect(brokenScheme).toBe("c:");
		// The pin: the patched derivation must NOT produce that rejected scheme.
		expect(new URL(patchedDerivation(WIN_MAIN)).protocol).not.toBe(brokenScheme);
	});

	it("is byte-identical to plain pathToFileURL on a POSIX absolute path", () => {
		const posixMain = "/repo/apps/web/alchemy.run.ts";
		expect(pathToFileURL(path.posix.resolve(posixMain)).href).toBe(
			"file:///repo/apps/web/alchemy.run.ts",
		);
	});
});
