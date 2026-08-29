import {type ChildProcess, spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {unlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {expect, test} from "@playwright/test";

const harness = fileURLToPath(new URL("./tuval-server.mjs", import.meta.url));

const start = async () => {
	const handshake = join(tmpdir(), `tuval-extension-ui-${randomUUID()}`);
	const child = spawn(
		process.execPath,
		[harness, "0", "../fixtures/extension-ui", "../fixtures/extension-ui-peer"],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: {...process.env, TUVAL_EXTENSION_UI_HANDSHAKE: handshake},
		},
	);
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
	return {child, handshake, url};
};

const stop = async (child: ChildProcess) => {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
};

const restartWithPeerSnapshot = async (server: Awaited<ReturnType<typeof start>>) => {
	await stop(server.child);
	const child = spawn(
		process.execPath,
		[harness, new URL(server.url).port, "../fixtures/extension-ui-peer"],
		{stdio: ["ignore", "pipe", "pipe"]},
	);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Tuval reconnect fixture did not start")),
			10_000,
		);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
			if (stdout.includes(`Tuval ready at ${server.url}`)) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("exit", (code) =>
			reject(new Error(`reconnect fixture exited (${code}): ${stderr}`)),
		);
	});
	return {...server, child};
};

test("real server preserves correlation, placement, scoped isolation, and mounted reconnect", async ({
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
	let server = await start();
	try {
		await page.goto(server.url);
		await expect(page.getByText("eş paket durumu")).toBeVisible();
		await writeFile(server.handshake, "browser attached\n", "utf8");

		await expect(page.getByText("Fixture bildirimi")).toBeVisible();
		await expect(page.getByText("fixture hazır")).toBeVisible();
		await expect(page.getByText("diğer oturum")).toBeVisible();
		await expect(page.getByText("eş paket durumu")).toBeVisible();
		await expect(
			page.getByRole("region", {name: "Editörün üstündeki paket widget'ları"}),
		).toContainText("select");
		await expect(
			page.getByRole("region", {name: "Editörün altındaki paket widget'ları"}),
		).toContainText("peer below");
		await expect(page.getByRole("alert").filter({hasText: "setTitle"})).toBeVisible();
		await expect(page.getByText(/set_editor_text işleme alınmak üzere ertelendi/)).toBeVisible();

		await expect(page.getByRole("heading", {name: "Süre aşımı"})).toBeVisible();
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
		const input = page.getByRole("textbox", {name: "Yanıt"});
		await input.fill("");
		await page.getByRole("button", {name: "Gönder"}).dblclick();

		await expect(page.getByRole("heading", {name: "Fixture editörü"})).toBeVisible();
		const editor = page.getByRole("textbox", {name: "Fixture editörü"});
		await expect(editor).toBeFocused();
		await editor.fill("");
		await page.keyboard.press("Tab");
		await page.keyboard.press("Tab");
		await page.keyboard.press("Tab");
		await expect(editor).toBeFocused();
		await page.getByRole("button", {name: "Gönder"}).click();

		await expect(page.getByRole("heading", {name: "Fixture iptali"})).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);

		const responseOperations = mutations.filter(({name}) => name === "extensionUi.respond");
		const cancelOperations = mutations.filter(({name}) => name === "extensionUi.cancel");
		expect(responseOperations).toHaveLength(4);
		expect(cancelOperations).toHaveLength(1);
		expect(
			responseOperations.map(
				({input: operationInput}) => (operationInput as {response: {id: string}}).response.id,
			),
		).toEqual(["select", "confirm", "input", "editor"]);
		expect(
			cancelOperations.map(({input: operationInput}) => (operationInput as {id: string}).id),
		).toEqual(["cancel"]);
		expect((responseOperations[2]?.input as {response: {value: string}}).response.value).toBe("");
		expect((responseOperations[3]?.input as {response: {value: string}}).response.value).toBe("");

		const desktop = testInfo.outputPath("extension-ui-desktop.png");
		await page.screenshot({path: desktop, fullPage: true});
		await testInfo.attach("extension-ui-desktop", {path: desktop, contentType: "image/png"});

		const responsesBeforeReconnect = responseOperations.length;
		const restart = restartWithPeerSnapshot(server);
		await expect(page.locator(".extension-ui__connection")).toHaveAttribute(
			"data-state",
			"disconnected",
		);
		server = await restart;
		await expect(page.locator(".extension-ui__connection")).toHaveAttribute(
			"data-state",
			"connected",
		);
		await expect(page.getByText("fixture hazır")).toHaveCount(0);
		await expect(page.getByText("select", {exact: true})).toHaveCount(0);
		await expect(page.getByText("diğer oturum")).toHaveCount(0);
		await expect(page.getByText("eş paket durumu")).toBeVisible();
		await expect(page.getByText("peer below")).toBeVisible();
		await expect(page.getByText("Fixture bildirimi")).toHaveCount(0);
		await expect(page.getByText(/setTitle bu tarayıcıda/)).toHaveCount(0);
		await expect(page.getByRole("dialog")).toHaveCount(0);
		expect(mutations.filter(({name}) => name === "extensionUi.respond")).toHaveLength(
			responsesBeforeReconnect,
		);

		await page.setViewportSize({width: 390, height: 844});
		const mobile = testInfo.outputPath("extension-ui-mobile.png");
		await page.screenshot({path: mobile});
		await testInfo.attach("extension-ui-mobile", {path: mobile, contentType: "image/png"});
		expect(errors).toEqual([]);
	} finally {
		await stop(server.child);
		await unlink(server.handshake).catch(() => undefined);
	}
});
