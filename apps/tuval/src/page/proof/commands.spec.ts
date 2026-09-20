import {expect, type Page, test} from "@playwright/test";
import {COMMAND_CONTROL_PORT} from "./names.ts";

const control = `http://127.0.0.1:${COMMAND_CONTROL_PORT}`;
const openLine = async (page: Page) => {
	await page.keyboard.press("Control+b");
	await page.keyboard.press(":");
	const input = page.getByRole("textbox", {name: "Type a command"});
	await expect(input).toBeVisible();
	return input;
};

test("ordinary program commands use the live kernel from both desk surfaces", async ({
	page,
	request,
}, testInfo) => {
	const {pageUrl} = (await (await request.get(`${control}/state`)).json()) as {pageUrl: string};
	await page.goto(pageUrl);
	const counter = page.getByLabel("Counter value");
	await expect(counter).toHaveText("0");
	await page.screenshot({path: testInfo.outputPath("before-desk.png")});
	await page.keyboard.press("Meta+k");
	const palette = page.getByRole("combobox", {name: "Run a spell"});
	await palette.fill("counter");
	await expect(page.getByRole("option", {name: /counter tick/})).toBeVisible();
	await page.screenshot({path: testInfo.outputPath("palette-discovery.png")});
	await palette.fill("counter ti");
	await palette.press("Tab");
	await expect(palette).toHaveValue("counter tick ");
	await palette.press("Enter");
	await expect(palette).toHaveCount(0);
	await expect(counter).toHaveText("1");
	await page.screenshot({path: testInfo.outputPath("palette-success.png")});
	let line = await openLine(page);
	await line.fill("counter tick");
	await line.press("Enter");
	const result = page.getByRole("form", {name: "Command line"}).getByRole("status");
	await expect(result).toHaveText("2");
	await expect(counter).toHaveText("2");
	await page.screenshot({path: testInfo.outputPath("command-success.png")});
	for (const [index, command] of [
		"help counter tick",
		'help "counter tick"',
		"help counter.tick",
		"spell describe counter tick",
		'spell describe "counter tick"',
		"spell describe counter.tick",
	].entries()) {
		await line.fill(command);
		await line.press("Enter");
		await expect(result).toContainText("Add one to the ordinary counter.");
		await expect(result).toContainText(index < 3 ? '"counter tick"' : '"counter"');
		await page.screenshot({path: testInfo.outputPath(`describe-${index + 1}.png`)});
	}
	await line.fill("counter refuse");
	await line.press("Enter");
	await expect(page.getByRole("alert")).toContainText("The counter refused this command.");
	await page.screenshot({path: testInfo.outputPath("command-refusal.png")});
	await line.press("Escape");
	await page.keyboard.press("Meta+k");
	await palette.fill("counter refuse");
	await palette.press("Enter");
	await expect(page.getByText(/The counter refused this command/).first()).toBeVisible();
	await page.screenshot({path: testInfo.outputPath("palette-refusal.png")});
	await palette.press("Escape");
	await page.keyboard.press("Meta+k");
	await palette.fill("counter");
	await expect(page.getByRole("option", {name: /counter tick/})).toBeVisible();
	await page.evaluate(() => {
		document.documentElement.dataset.commandProof = "kept";
	});
	await request.get(`${control}/remove`);
	await expect(page.getByRole("option", {name: /counter tick/})).toHaveCount(0);
	await expect(page.getByRole("option", {name: /counter read/})).toBeVisible();
	await request.get(`${control}/cut`);
	await expect(page.getByRole("option", {name: /counter read/})).toHaveCount(0);
	await request.get(`${control}/restore`);
	await expect(page.getByRole("option", {name: /counter read/})).toBeVisible();
	await expect(page.getByRole("option", {name: /counter tick/})).toHaveCount(0);
	expect(await page.evaluate(() => document.documentElement.dataset.commandProof)).toBe("kept");
	await palette.press("Escape");
	line = await openLine(page);
	await line.fill("counter read");
	await line.press("Enter");
	await expect(result).toHaveText("2");
	await request.get(`${control}/reset`);
});
