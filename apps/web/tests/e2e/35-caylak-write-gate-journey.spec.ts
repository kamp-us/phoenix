import {expect, type Page, test} from "@playwright/test";
import {wire} from "../../src/i18n/tr/wire";
import {signOut, signUp} from "./_helpers/auth";
import {promoteToYazar} from "./_helpers/promote";
import {randomSuffix} from "./_helpers/rand";

/**
 * The çaylak write gate journey (ADR 0434, #7485) @journey:phoenix-email-verified-writes.
 *
 * An unverified çaylak signs up, signs out, signs back in through the real `/auth` form, and reads
 * a real post, its comment and a real definition. Then its comment is refused with the
 * `EMAIL_UNVERIFIED` copy from the i18n catalog.
 *
 * The flag defaults OFF, and the e2e preview runs `ENVIRONMENT=preview`, where the
 * `phoenix_flag_overrides` cookie is dropped (FlagsContext), so the server gate cannot be turned on
 * per request from here. The split follows `30-member-mute-journey`: the server denial on real D1
 * is proven in `tests/integration/caylak-write-gate.test.ts`; this spec proves sign-in and reads
 * are untouched for an unverified account, and replays the server's `EMAIL_UNVERIFIED` answer on
 * `comment.add` to prove the rendered denial.
 */

/** Answer every `comment.add` op with the gate's wire error; pass every other `/fate` request. */
async function refuseCommentAddAsUnverified(page: Page): Promise<void> {
	await page.route("**/fate", async (route) => {
		const request = route.request();
		if (request.method() !== "POST") return route.continue();
		let body: {operations?: Array<Record<string, unknown>>} = {};
		try {
			body = JSON.parse(request.postData() ?? "{}");
		} catch {
			return route.continue();
		}
		const operations = Array.isArray(body.operations) ? body.operations : [];
		if (operations.length === 0 || !operations.every((op) => op.name === "comment.add")) {
			return route.continue();
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				version: 1,
				results: operations.map((op) => ({
					id: op.id,
					ok: false,
					error: {
						code: "EMAIL_UNVERIFIED",
						message: "Yazabilmek için önce e-posta adresini doğrulaman gerekiyor.",
					},
				})),
			}),
		});
	});
}

async function chooseUsername(page: Page, handle: string): Promise<void> {
	await page.locator("input#bootstrap-username").fill(handle);
	await page.getByRole("button", {name: /devam et/i}).click();
	await expect(page.getByRole("heading", {name: /kullanıcı adını seç/i})).toHaveCount(0, {
		timeout: 10_000,
	});
}

test.describe("çaylak write gate @journey:phoenix-email-verified-writes", () => {
	test("an unverified çaylak signs in and reads, and its comment is refused with the verify copy", async ({
		page,
	}) => {
		const suffix = `${Date.now().toString(36)}${randomSuffix(4)}`;

		// A yazar authors the content the çaylak will read: a çaylak's own content lands sandboxed.
		const authorEmail = `gy${suffix}@kamp.us`;
		await signUp(page, {email: authorEmail});
		await promoteToYazar(authorEmail);
		await chooseUsername(page, `gy-${suffix}`);

		await page.goto("/pano/yeni");
		const title = `gate başlık ${suffix}`;
		await page.locator('[data-testid="pano-submit-url"]').fill(`https://example.com/${suffix}`);
		await page.locator('[data-testid="pano-submit-title"]').fill(title);
		await page.locator('[data-testid="pano-submit-tag-discuss"]').click();
		await page.locator('[data-testid="pano-submit-submit"]').click();
		await page.waitForURL(/\/pano\/post_[A-Za-z0-9]+$/, {timeout: 15_000});
		const postPath = new URL(page.url()).pathname;
		await expect(page.getByRole("heading", {name: /0 yorum/i})).toBeVisible({timeout: 10_000});

		const commentBody = `yazar yorumu ${suffix}`;
		await page.locator('[data-testid="pano-comment-input"]').fill(commentBody);
		await page.locator('[data-testid="pano-comment-submit"]').click();
		await expect(page.getByRole("heading", {name: /1 yorum/i})).toBeVisible({timeout: 15_000});

		const slug = `gate-${suffix}`;
		const definitionBody = `yazar tanımı ${suffix}`;
		await page.goto(`/sozluk/${slug}`);
		await page.locator('[data-testid="sozluk-composer-body"]').fill(definitionBody);
		await page.locator('[data-testid="sozluk-composer-submit"]').click();
		await expect(page.getByText(definitionBody)).toBeVisible({timeout: 15_000});
		await signOut(page);

		// The çaylak: a fresh sign-up is never verified, since nobody opens its email link.
		const creds = await signUp(page, {email: `gc${suffix}@kamp.us`});
		await chooseUsername(page, `gc-${suffix}`);
		await signOut(page);

		// Sign-in stays ungated (ADR 0434): the real form lands a session.
		await page.goto("/auth");
		await page.getByLabel("e-posta").fill(creds.email);
		await page.getByLabel("parola", {exact: true}).fill(creds.password);
		await page.locator("button[type='submit'].kp-auth__submit").click();
		await page.waitForURL((url) => !url.pathname.startsWith("/auth"), {timeout: 10_000});
		await expect(page.locator(".kp-topbar__user")).toBeVisible({timeout: 10_000});

		// Reads stay ungated: the post, its comment and the definition all render.
		await page.goto(postPath);
		await expect(page.getByRole("heading", {level: 1})).toContainText(title, {timeout: 10_000});
		await expect(page.getByText(commentBody).first()).toBeVisible({timeout: 10_000});
		await page.goto(`/sozluk/${slug}`);
		await expect(page.getByText(definitionBody)).toBeVisible({timeout: 15_000});

		// The write is refused, and the refusal reads from the catalog.
		await refuseCommentAddAsUnverified(page);
		await page.goto(postPath);
		await expect(page.getByRole("heading", {name: /1 yorum/i})).toBeVisible({timeout: 10_000});
		await page.locator('[data-testid="pano-comment-input"]').fill(`çaylak yorumu ${suffix}`);
		await page.locator('[data-testid="pano-comment-submit"]').click();
		await expect(page.getByTestId("pano-comment-error")).toContainText(
			wire["wire.EMAIL_UNVERIFIED"],
			{
				timeout: 10_000,
			},
		);
		await expect(page.getByRole("heading", {name: /1 yorum/i})).toBeVisible();
	});
});
