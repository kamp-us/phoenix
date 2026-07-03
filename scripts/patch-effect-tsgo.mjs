// Idempotent postinstall wrapper for `effect-tsgo patch` (issue #1800).
//
// `@effect/tsgo`'s `patch` command (dist/effect-tsgo.js) swaps the vendored
// TypeScript-Go binary at
//   node_modules/.pnpm/@typescript+native-preview-<plat>/.../lib/<tsgo>
// for the Effect Language Service build, backing up whatever is currently there
// to `<tsgo>.original`, then `<tsgo>.original.1`, `.2`, … It NEVER prunes those
// backups, so every `pnpm install` (which runs the root `postinstall`) accretes
// one more numbered backup until patch's own guard trips with
//   "Too many backup files exist (over 100)"
// and aborts the install — the exact failure #1800 hit at 101 backups (~3 GB).
//
// The fix (ADR 0038 tier-1 — work around it in our own code, no dependency
// patch): before patching, restore a clean unpatched binary and delete the
// accumulated backup litter, so the backup counter never climbs. Net steady
// state after every install: exactly one `<tsgo>` (patched) and one
// `<tsgo>.original` (pristine), never a growing pile.
//
// Runs mid-install with zero workspace deps — Node builtins only.

import {spawnSync} from "node:child_process";
import {existsSync, readdirSync, renameSync, rmSync} from "node:fs";
import {createRequire} from "node:module";
import {basename, dirname, join} from "node:path";

const require = createRequire(join(process.cwd(), "noop.js"));

// Resolve the native-preview platform lib dir the way effect-tsgo itself does
// (getNativePreviewBinaryPath): from the meta package to the per-platform
// package's lib/. If native-preview isn't installed we simply skip cleanup and
// let `effect-tsgo patch` report its own diagnostic.
function resolveTsgoBinaryPath() {
	const metaPkg = require.resolve("@typescript/native-preview/package.json");
	const platRequire = createRequire(metaPkg);
	const platformPkg = `@typescript/native-preview-${process.platform}-${process.arch}`;
	const platformPkgJson = platRequire.resolve(`${platformPkg}/package.json`);
	const binaryName = process.platform === "win32" ? "tsgo.exe" : "tsgo";
	return join(dirname(platformPkgJson), "lib", binaryName);
}

function pruneBackups() {
	let targetPath;
	try {
		targetPath = resolveTsgoBinaryPath();
	} catch {
		// native-preview not resolvable yet — nothing to prune; patch will speak.
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
		console.log(`patch-effect-tsgo: pruned ${removed} stale tsgo backup file(s) in ${dir}`);
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
