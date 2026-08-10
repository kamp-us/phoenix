#!/usr/bin/env node
/**
 * Provision the headless browser `fabrika ui render` needs, **as part of installing the package**.
 *
 * The founder preference this encodes: default-available beats install-a-thing. No operator and no
 * agent ever runs a separate browser-install step by hand, so it rides `postinstall` — which is the
 * only moment that is guaranteed to happen once per install, for a workspace member and for an
 * adopter's `pnpm add -g @kampus/fabrika-cli` alike.
 *
 * It is **best-effort by design and never fails the install.** A hard failure here would break
 * `pnpm install` for everyone over a capability only one verb needs, and the run-time story is
 * already fail-closed and actionable: `ui render` exits `11` naming the exact remediation command.
 *
 * Two skips, each a real provisioning state rather than a convenience:
 *   - `FABRIKA_SKIP_BROWSER_PROVISION=1` — the explicit opt-out.
 *   - `PLAYWRIGHT_BROWSERS_PATH` set — a managed/prebaked install already owns the browsers.
 *
 * There is deliberately no `CI` skip (#5169): it fired *before* the presence check below, so it was
 * load-bearing only on a CI image with no chromium — exactly the case the criterion above must
 * cover. CI pays the download once per cache key, not once per job; see the browser cache in
 * `.github/workflows/ci.yml`.
 */
import {spawnSync} from "node:child_process";
import {existsSync} from "node:fs";

const skip = (reason) => {
	process.stderr.write(`fabrika: skipping headless-browser provisioning — ${reason}.\n`);
	process.exit(0);
};

if (process.env.FABRIKA_SKIP_BROWSER_PROVISION === "1") skip("FABRIKA_SKIP_BROWSER_PROVISION=1");
if ((process.env.PLAYWRIGHT_BROWSERS_PATH ?? "") !== "")
	skip("PLAYWRIGHT_BROWSERS_PATH names a managed install");

let installed = false;
try {
	const {chromium} = await import("@playwright/test");
	installed = existsSync(chromium.executablePath());
} catch {
	installed = false;
}
if (installed) skip("chromium is already provisioned");

const result = spawnSync("pnpm", ["exec", "playwright", "install", "chromium"], {
	stdio: "inherit",
	timeout: 10 * 60 * 1000,
});
if (result.status !== 0) {
	process.stderr.write(
		"fabrika: headless-browser provisioning did not complete; `fabrika ui render` will refuse with exit 11 and the remediation command until it does.\n",
	);
}
process.exit(0);
