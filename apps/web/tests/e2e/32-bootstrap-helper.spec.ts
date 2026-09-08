import {expect, test} from "@playwright/test";
import {completeBootstrap} from "./_helpers/auth";

test.describe("fresh-account bootstrap helper", () => {
	test("rejects a missing gate instead of treating it as a completed account", async ({page}) => {
		await page.setContent("<main>Waiting for account data</main>");
		await expect(completeBootstrap(page)).rejects.toThrow(/bootstrap-username/);
	});

	test("waits for the gate and completes the two-click prefill confirmation", async ({page}) => {
		await page.setContent("<main></main>");
		const completion = completeBootstrap(page);
		await page.evaluate(() => {
			const main = document.querySelector("main");
			if (main === null) throw new Error("Missing fixture main");
			main.innerHTML = `
				<h2>kullanıcı adını seç</h2>
				<form>
					<input id="bootstrap-username" value="test-reader" />
					<button type="submit" class="kp-auth__submit">devam et</button>
				</form>`;
			let submits = 0;
			main.querySelector("form")?.addEventListener("submit", (event) => {
				event.preventDefault();
				submits += 1;
				if (submits === 2) main.innerHTML = "<p>Account ready</p>";
			});
		});
		await completion;
		await expect(page.getByText("Account ready")).toBeVisible();
	});
});
