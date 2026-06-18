import {test as setup} from "@playwright/test";
import {completeBootstrap, signUpViaApi} from "../_helpers/auth";
import {STORAGE_STATE} from "../_helpers/storage-state";

// One real sign-up per CI run, amortized across every authed spec (ADR 0085).
// The `authed` project `dependsOn`s this setup and reuses the captured cookies via
// `use.storageState`, so authed specs start logged in without re-signing-up per test.
// The session is real (full Better Auth flow + remote D1 write), captured fresh per
// run, and never committed — no standing credential, no test-only auth bypass.
//
// Auth is via the better-auth API (`/api/auth/sign-up/email`), not the UI: the
// API call lands the session cookie in the page context deterministically and
// fails loudly with the HTTP status on a genuine sign-up failure, where the old
// UI flow only surfaced a nav timeout. The username bootstrap still goes through
// the app's own form (`completeBootstrap`) so the captured session is fully
// usable — a fresh user has `username = NULL` and the authed specs would
// otherwise see the bootstrap gate instead of content.
setup("authenticate", async ({page}) => {
	await signUpViaApi(page);
	// Loading any in-app route with the session cookie set mounts the Layout,
	// which raises the username-bootstrap gate for the fresh (username-NULL) user.
	await page.goto("/");
	await completeBootstrap(page);
	await page.context().storageState({path: STORAGE_STATE});
});
