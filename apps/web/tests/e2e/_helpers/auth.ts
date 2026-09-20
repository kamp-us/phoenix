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

const GATE_CLEAR_TIMEOUT_MS = 10_000;
const GATE_POLL_MS = 100;
// The confirm arm is a local React re-render, so it lands in milliseconds. Kept well under the
// gate wait because the `setup` project's whole test budget is 15s: the two waits must be able to
// run back to back and still leave the gate's own diagnostic room to print.
const CONFIRM_ARM_TIMEOUT_MS = 2_000;

/**
 * Wait for the bootstrap gate to come down, and name WHY when it does not. <UsernameBootstrap>
 * leaves the heading mounted on a rejected `setUsername`, on a local rule rejection and on an
 * `onComplete` that never re-reads `username`, and only the rendered `.kp-auth__error` alert tells
 * the first two apart from the third — watching the heading alone reports all three as one
 * indistinguishable timeout (#8659).
 */
async function expectGateCleared(page: Page): Promise<void> {
	const heading = page.getByRole("heading", {name: /kullanıcı adını seç/i});
	const alert = page.locator(".kp-auth__error");
	const deadline = Date.now() + GATE_CLEAR_TIMEOUT_MS;

	for (;;) {
		if ((await heading.count()) === 0) return;
		if ((await alert.count()) > 0) {
			const reason = (await alert.first().innerText()).trim();
			throw new Error(
				`username bootstrap refused the handle: "${reason}" — the gate stayed up because ` +
					`setUsername or the local username rule rejected it, not because the submit was slow.`,
			);
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`username bootstrap gate still mounted after ${GATE_CLEAR_TIMEOUT_MS}ms with no ` +
					`.kp-auth__error rendered — nothing rejected the handle, so either the submit never ` +
					`committed or onComplete resolved without the layout re-reading username.`,
			);
		}
		await page.waitForTimeout(GATE_POLL_MS);
	}
}

/**
 * Complete the username bootstrap gate for a fresh account. A new user has `username = NULL`, so
 * the Layout replaces the page content with <UsernameBootstrap> — specs that sign up and then
 * assert page content must clear this first or they see the form.
 *
 * The double click is #1888 AC4: an *unedited* prefill only ARMS confirm on the first click and
 * commits on the second, while an edited value commits on click one (so the second click is
 * skipped). Which arm applies is decided by the handle this helper itself fills, never probed from
 * the page: `needsConfirm` is `value === prefill && !confirmed`, and a fresh gate mounts with
 * `confirmed = false`, so submitting the prefill back needs two clicks and any other handle needs
 * one. Specs that need a specific handle drive the gate themselves and are unaffected.
 */
export async function completeBootstrap(page: Page): Promise<void> {
	const input = page.locator("input#bootstrap-username");
	// Every caller just signed up: an absent gate is failed setup, never a completed account.
	await expect(input).toBeVisible({timeout: 10_000});
	const prefilled = await input.inputValue();
	const submitsThePrefill = prefilled.length >= 3;
	const handle = submitsThePrefill
		? prefilled
		: `e2e${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
	await input.fill(handle);

	// Select by the stable submit class, NOT the label: the label now varies
	// ("bu adı onayla" while confirm is armed vs "devam et" otherwise, #1888 AC4).
	const submit = page.locator("button[type='submit'].kp-auth__submit");

	await submit.click();
	if (submitsThePrefill) {
		// The first click only armed confirm. Manti renders the field's hint as `<id>-hint`, and
		// <UsernameBootstrap> passes the confirm hint exactly while `needsConfirm` holds, so the
		// hint leaving the DOM is the app's own proof that React committed the arm.
		await expect(page.locator("#bootstrap-username-hint")).toHaveCount(0, {
			timeout: CONFIRM_ARM_TIMEOUT_MS,
		});
		await submit.click();
	}
	await expectGateCleared(page);
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
