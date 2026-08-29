import {type ChildProcess, spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {expect, test} from "@playwright/test";

const harness = fileURLToPath(new URL("./tuval-server.mjs", import.meta.url));

const start = async () => {
	const child = spawn(process.execPath, [harness, "0", "../fixtures/extension-ui"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const url = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Tuval extension UI fixture did not start")),
			10_000,
		);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
			const match = /Tuval ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
			if (match?.[1] !== undefined) {
				clearTimeout(timer);
				resolve(match[1]);
			}
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`fixture exited (${code}): ${stderr}`)));
	});
	return {child, url};
};

const stop = async (child: ChildProcess) => {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
};

test("fixture extension exercises every method, result/cancel, timeout, replay, focus, and unload", async ({
	page,
}, testInfo) => {
	const errors: Array<string> = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const mutations: Array<{name?: string; input?: unknown}> = [];
	page.on("request", (request) => {
		if (!request.url().endsWith("/fate") || request.method() !== "POST") return;
		const operation = request.postDataJSON()?.operations?.[0];
		if (operation?.name?.startsWith("extensionUi.")) mutations.push(operation);
	});
	const server = await start();
	try {
		await page.goto(server.url);
		await expect(page.getByText("Fixture bildirimi")).toBeVisible();
		await expect(page.getByText("fixture hazır")).toBeVisible();
		await expect(page.getByText("diğer oturum")).toBeVisible();
		await expect(page.getByText("editor", {exact: true})).toBeVisible();
		await expect(page.getByRole("alert").filter({hasText: "setTitle"})).toBeVisible();
		await expect(page.getByText(/set_editor_text işleme alınmak üzere ertelendi/)).toBeVisible();

		const timeoutDialog = page.getByRole("dialog");
		await expect(timeoutDialog).toContainText("Süre aşımı");
		await expect(page.getByRole("heading", {name: "Süre aşımı"})).toHaveCount(0);
		await expect(page.getByText(/confirm isteği timeout sonucu ile kapandı/)).toBeVisible();

		await expect(page.getByRole("heading", {name: "Fixture seçimi"})).toBeVisible();
		const select = page.getByRole("combobox", {name: "Seçim"});
		await expect(select).toBeFocused();
		await select.selectOption("beta");
		await page.getByRole("button", {name: "Gönder"}).click();

		await expect(page.getByRole("heading", {name: "Fixture onayı"})).toBeVisible();
		await page.getByRole("button", {name: "Reddet"}).click();

		await expect(page.getByRole("heading", {name: "Fixture girdisi"})).toBeVisible();
		await page.getByRole("textbox", {name: "Yanıt"}).fill("iptal edilecek");
		await page.keyboard.press("Escape");

		await expect(page.getByRole("heading", {name: "Fixture editörü"})).toBeVisible();
		const editor = page.getByRole("textbox", {name: "Fixture editörü"});
		await expect(editor).toBeFocused();
		await editor.pressSequentially(" tamamlandı");
		await page.keyboard.press("Tab");
		await page.keyboard.press("Tab");
		await page.keyboard.press("Tab");
		await expect(editor).toBeFocused();
		await page.getByRole("button", {name: "Gönder"}).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);

		await expect(page.getByText(/Paket oturumu kaldırıldı/)).toBeVisible();
		await expect(page.getByText("diğer oturum")).toHaveCount(0);
		const responseOperations = mutations.filter(({name}) => name === "extensionUi.respond");
		const cancelOperations = mutations.filter(({name}) => name === "extensionUi.cancel");
		expect(responseOperations).toHaveLength(3);
		expect(cancelOperations).toHaveLength(1);
		expect(
			responseOperations.map(({input}) => (input as {response: {id: string}}).response.id),
		).toEqual(["select", "confirm", "editor"]);
		expect(cancelOperations.map(({input}) => (input as {id: string}).id)).toEqual(["input"]);

		const desktop = testInfo.outputPath("extension-ui-desktop.png");
		await page.screenshot({path: desktop, fullPage: true});
		await testInfo.attach("extension-ui-desktop", {path: desktop, contentType: "image/png"});

		await page.reload();
		await expect(page.getByText("fixture hazır")).toBeVisible();
		await expect(page.getByText("editor", {exact: true})).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(page.getByText("Fixture bildirimi")).toHaveCount(0);
		await expect(page.getByText(/setTitle bu tarayıcıda/)).toHaveCount(0);

		await page.setViewportSize({width: 390, height: 844});
		const mobile = testInfo.outputPath("extension-ui-mobile.png");
		await page.screenshot({path: mobile});
		await testInfo.attach("extension-ui-mobile", {path: mobile, contentType: "image/png"});
		expect(errors).toEqual([]);
	} finally {
		await stop(server.child);
	}
});
