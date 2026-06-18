import {test as setup} from "@playwright/test";
import {completeBootstrap, signUp} from "../_helpers/auth";
import {STORAGE_STATE} from "../_helpers/storage-state";

// One real sign-up per CI run, amortized across every authed spec (ADR 0085).
// The `authed` project `dependsOn`s this setup and reuses the captured cookies via
// `use.storageState`, so authed specs start logged in without re-signing-up per test.
// The session is real (full Better Auth flow + remote D1 write), captured fresh per
// run, and never committed — no standing credential, no test-only auth bypass.
setup("authenticate", async ({page}) => {
	await signUp(page);
	await completeBootstrap(page);
	await page.context().storageState({path: STORAGE_STATE});
});
