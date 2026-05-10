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
export async function signUp(page: Page, opts?: Partial<Credentials>): Promise<Credentials> {
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const email = opts?.email ?? `e2e-${suffix}@kamp.us`;
	const password = opts?.password ?? "hunter222!";
	const name = opts?.name ?? "e2e tester";

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
