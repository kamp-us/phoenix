import {randomUUID} from "node:crypto";
import {expect, type Page} from "@playwright/test";

export interface Credentials {
	email: string;
	password: string;
	name: string;
}

/**
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
 * The SETUP's auth path (ADR 0085): POST better-auth's sign-up route instead of driving the
 * AuthPage UI. `page.request` shares the page's context, so the session `Set-Cookie` is captured
 * by a subsequent `storageState()` — no nav, no form, no redirect race.
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

	await page.getByRole("button", {name: /^kayıt ol$/i}).click();
	await expect(page.getByRole("heading", {name: /kayıt ol/i})).toBeVisible();

	await page.getByLabel("görünen ad").fill(name);
	await page.getByLabel("e-posta").fill(email);
	await page.getByLabel("parola", {exact: true}).fill(password);
	await page.getByRole("button", {name: /hesap aç/i}).click();

	// Layout's effect navigates off /auth once session.data lands.
	await page.waitForURL((url) => !url.pathname.startsWith("/auth"), {timeout: 10_000});
	return {email, password, name};
}

/**
 * Complete the username bootstrap gate if it's up. A fresh Pasaport user has `username = NULL`, so
 * the Layout replaces the page content with <UsernameBootstrap> — specs that sign up and then
 * assert page content must clear this first or they see the form.
 *
 * The double click is #1888 AC4: an *unedited* prefill only ARMS confirm on the first click and
 * commits on the second, while an edited value commits on click one (so the second click is
 * skipped). Specs that need a specific handle drive the gate themselves and are unaffected.
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
	if (await heading.isVisible().catch(() => false)) {
		await submit.click();
	}
	await expect(heading).toHaveCount(0, {timeout: 10_000});
}

/**
 * Click the topbar user pill, then "çıkış" in the account popover. The panel's rows are real links
 * and a real button, NOT menu commands, so çıkış has the button role. Best-effort — no-op if the
 * pill is already gone.
 */
export async function signOut(page: Page): Promise<void> {
	const pill = page.locator(".kp-topbar__user").first();
	if (!(await pill.isVisible().catch(() => false))) return;
	await pill.click();
	await page.getByRole("button", {name: /çıkış/i}).click();
	await expect(pill).toBeHidden({timeout: 5_000});
}
