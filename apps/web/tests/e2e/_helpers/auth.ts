import {randomUUID} from "node:crypto";
import {expect, type Page} from "@playwright/test";

export interface Credentials {
	email: string;
	password: string;
	name: string;
}

/**
 * Sign up a fresh user via the AuthPage. The flow:
 *   1. visit /auth (which defaults to sign-in)
 *   2. flip to sign-up via the "kayıt ol" toggle button
 *   3. fill name/email/password, submit
 *   4. wait for the redirect off /auth (Layout pushes to "/" once
 *      session.data exists)
 *
 * Each call gets a unique email so tests don't collide on Better Auth's
 * unique-email constraint when re-run.
 */
function freshCredentials(opts?: Partial<Credentials>): Credentials {
	// crypto.randomUUID over Math.random: js/insecure-randomness (#3341) — the suffix
	// ids a credential fixture, a context where CodeQL expects a cryptographic source.
	const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
	return {
		email: opts?.email ?? `e2e-${suffix}@kamp.us`,
		password: opts?.password ?? "hunter222!",
		name: opts?.name ?? "e2e tester",
	};
}

/**
 * Sign up a fresh user by POSTing better-auth's `/api/auth/sign-up/email`
 * directly, instead of driving the AuthPage UI. With auto-sign-in on, the
 * response lands a session `Set-Cookie`; using `page.request` shares the page's
 * context, so the cookie is captured by a subsequent `storageState()` (the
 * setup's robust pattern — no nav, no form, no redirect race). This is the
 * SETUP's auth path (ADR 0085); the UI `signUp` above is kept for local specs.
 *
 * Fails loudly with the status + a trimmed body on a non-ok response: if sign-up
 * genuinely fails on the target, we see exactly why instead of a nav timeout.
 */
export async function signUpViaApi(page: Page, opts?: Partial<Credentials>): Promise<Credentials> {
	const creds = freshCredentials(opts);

	const res = await page.request.post("/api/auth/sign-up/email", {
		data: {name: creds.name, email: creds.email, password: creds.password},
	});

	if (!res.ok()) {
		const body = (await res.text().catch(() => "")).slice(0, 500);
		throw new Error(`sign-up/email failed: ${res.status()} ${res.statusText()} — ${body}`);
	}

	return creds;
}

export async function signUp(page: Page, opts?: Partial<Credentials>): Promise<Credentials> {
	const {email, password, name} = freshCredentials(opts);

	await page.goto("/auth");

	// AuthPage opens in sign-in mode; the toggle to sign-up is the
	// "kayıt ol" button at the bottom of the card.
	await page.getByRole("button", {name: /^kayıt ol$/i}).click();
	await expect(page.getByRole("heading", {name: /kayıt ol/i})).toBeVisible();

	await page.getByLabel("görünen ad").fill(name);
	await page.getByLabel("e-posta").fill(email);
	await page.getByLabel("parola").fill(password);
	await page.getByRole("button", {name: /hesap aç/i}).click();

	// Layout's effect navigates off /auth once session.data lands.
	await page.waitForURL((url) => !url.pathname.startsWith("/auth"), {timeout: 10_000});
	return {email, password, name};
}

/**
 * Complete the username bootstrap gate if it's up, committing the unedited
 * email-derived prefill.
 *
 * A fresh Pasaport user has `username = NULL`, so the Layout's `needsBootstrap`
 * gate replaces the page content with <UsernameBootstrap> until a username is
 * set (via `setUsername` over fate). Specs that sign up and then assert page
 * content (the feed, a post) must clear this gate first, or they see the form
 * instead of the content. Submits the pre-filled value (the email local-part,
 * unique per `signUp`). No-op if the gate isn't present (already bootstrapped).
 *
 * #1888 AC4 makes the *unedited* prefill a deliberate two-step confirm: because
 * a handle is permanent, submitting the untouched email-derived value doesn't
 * commit on the first click — it only arms confirm (the submit button reads
 * "bu adı onayla" on mount, not "devam et"), and a *second* submit commits. An
 * *edited* value still commits on the first click. So this helper: (1) selects
 * the submit button by its stable class, not the varying label; (2) clicks it,
 * and if the gate heading is still up after that, clicks once more (the confirm
 * path). That is robust for both paths — an edited handle commits on click one
 * and the second click is skipped; the unedited prefill arms on click one and
 * commits on click two.
 *
 * Specs that need a *specific* handle (e.g. to navigate to `/u/<handle>`) drive
 * the gate themselves with their chosen value instead of calling this — an
 * edited value commits in one click, so they are unaffected by the confirm step.
 */
export async function completeBootstrap(page: Page): Promise<void> {
	const input = page.locator("input#bootstrap-username");
	// The gate mounts only after `useMe` resolves (async over fate), so a
	// point-in-time visibility check races the fetch. Wait for it to appear; if
	// it never does within the window, assume the user is already bootstrapped.
	try {
		await expect(input).toBeVisible({timeout: 10_000});
	} catch {
		return;
	}
	const prefilled = await input.inputValue();
	const handle =
		prefilled && prefilled.length >= 3
			? prefilled
			: `e2e${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
	await input.fill(handle);

	// Select by the stable submit class, NOT the label: the label now varies
	// ("bu adı onayla" while confirm is armed vs "devam et" otherwise, #1888 AC4).
	const submit = page.locator("button[type='submit'].kp-auth__submit");
	const heading = page.getByRole("heading", {name: /kullanıcı adını seç/i});

	await submit.click();
	// The unedited prefill only ARMED confirm on click one, so the gate is still
	// up — a second click commits. An edited value already committed on click one,
	// so the gate is gone and this branch is skipped.
	if (await heading.isVisible().catch(() => false)) {
		await submit.click();
	}
	await expect(heading).toHaveCount(0, {timeout: 10_000});
}

/**
 * Click the topbar user pill, then "Çıkış" in the menu. The user pill is the
 * Menu.Trigger that wraps an Avatar + the user's display name. Best-effort —
 * if the menu is already gone, we just no-op.
 */
export async function signOut(page: Page): Promise<void> {
	// The user pill is a button containing the user's name text.
	const pill = page.locator(".kp-topbar__user").first();
	if (!(await pill.isVisible().catch(() => false))) return;
	await pill.click();
	await page.getByRole("menuitem", {name: /çıkış/i}).click();
	// Pill should disappear once session clears.
	await expect(pill).toBeHidden({timeout: 5_000});
}
