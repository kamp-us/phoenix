// Idempotent postinstall wrapper for `effect-tsgo patch` (issue #1800).
//
// `@effect/tsgo`'s `patch` command swaps the native TypeScript binary at
//   node_modules/.pnpm/@typescript+typescript-<plat>-<arch>/.../lib/<tsc>
// for the Effect Language Service build. In the `0.5.x` line this wrapper was
// written against, it backed up to `<tsc>.original`, then `<tsc>.original.1`,
// `.2`, … and NEVER pruned, so every `pnpm install` (which runs the root
// `postinstall`) accreted one more numbered backup until patch's own
//   "Too many backup files exist (over 100)"
// guard aborted the install — the failure #1800 hit at 101 backups (~3 GB).
//
// The pinned `@effect/tsgo@0.36.4` no longer does that: read from its
// `dist/effect-tsgo.cjs`, the only backup it writes is a single
// `<tsc>.original`, and when one already exists it renames the live binary to a
// `<tsc>.<uuid>.patched` quarantine that its own cleanup list removes; neither
// the numbered-backup path nor that guard string is in the bundle. So this is
// now a REGRESSION GUARD rather than a live fix (ADR 0038 tier-1 — work around
// it in our own code, no dependency patch): restoring the pristine binary and
// sweeping leftover backup litter before patching pins the steady state at
// exactly one `<tsc>` (patched) + one `<tsc>.original` (pristine), whichever
// backup scheme the tool uses.
//
// The patch target is the stable `typescript` compiler, not the retired
// `@typescript/native-preview` preview channel — see ADR 0271.
//
// Runs mid-install with zero workspace deps — Node builtins only.

import {spawnSync} from "node:child_process";
import {existsSync, readdirSync, renameSync, rmSync} from "node:fs";
import {createRequire} from "node:module";
import {basename, dirname, join} from "node:path";

const require = createRequire(join(process.cwd(), "noop.js"));

// Resolve the platform lib dir the way effect-tsgo itself does: from the
// `typescript` meta package to the per-platform package's lib/. If typescript
// isn't installed we simply skip cleanup and let `effect-tsgo patch` report its
// own diagnostic.
function resolveCompilerBinaryPath() {
	const metaPkg = require.resolve("typescript/package.json");
	const platRequire = createRequire(metaPkg);
	const platformPkg = `@typescript/typescript-${process.platform}-${process.arch}`;
	const platformPkgJson = platRequire.resolve(`${platformPkg}/package.json`);
	const binaryName = process.platform === "win32" ? "tsc.exe" : "tsc";
	return join(dirname(platformPkgJson), "lib", binaryName);
}

function pruneBackups() {
	let targetPath;
	try {
		targetPath = resolveCompilerBinaryPath();
	} catch {
		// typescript not resolvable yet — nothing to prune; patch will speak.
		return;
	}

	const dir = dirname(targetPath);
	const name = basename(targetPath);
	const pristine = `${targetPath}.original`;

	// If a pristine backup exists, the live binary is a prior patch's output.
	// Restore the pristine original over it so `patch` backs up the TRUE
	// original (not an already-patched copy) and yields one clean `.original`.
	if (existsSync(pristine)) {
		try {
			rmSync(targetPath, {force: true});
			renameSync(pristine, targetPath);
		} catch (err) {
			console.warn(`patch-effect-tsgo: could not restore ${pristine} → ${name}: ${err.message}`);
		}
	}

	// Delete every remaining backup artifact patch/unpatch leave behind:
	//   <name>.original, <name>.original.<n>, <name>.<uuid>.patched
	// (the restore above already consumed the canonical `.original`, but a
	// half-finished prior run may have left one; force-remove is idempotent).
	let removed = 0;
	for (const entry of readdirSync(dir)) {
		const isBackup =
			entry.startsWith(`${name}.original`) ||
			(entry.startsWith(`${name}.`) && entry.endsWith(".patched"));
		if (!isBackup) continue;
		try {
			rmSync(join(dir, entry), {force: true});
			removed++;
		} catch (err) {
			console.warn(`patch-effect-tsgo: could not remove backup ${entry}: ${err.message}`);
		}
	}
	if (removed > 0) {
		console.log(`patch-effect-tsgo: pruned ${removed} stale ${name} backup file(s) in ${dir}`);
	}
}

pruneBackups();

const result = spawnSync("effect-tsgo", ["patch"], {stdio: "inherit", shell: false});
if (result.error && result.error.code === "ENOENT") {
	// effect-tsgo not on PATH (e.g. --ignore-scripts or a partial install) —
	// the toolchain isn't linked yet; skip rather than fail the whole install.
	console.warn("patch-effect-tsgo: effect-tsgo not found on PATH — skipping patch.");
	process.exit(0);
}
process.exit(result.status ?? 0);
