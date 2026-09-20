// @patch-pin: alchemy@2.0.0-beta.77
import {readFileSync} from "node:fs";
import {URL} from "node:url";
import {runInNewContext} from "node:vm";
import {describe, expect, it} from "vitest";

const provider = readFileSync(
	new URL("./Cloudflare/Workers/WorkerProvider.js", import.meta.resolve("alchemy")),
	"utf8",
);
const expression = provider.match(/const placeholderScript = (`[\s\S]*?`);/)?.[1];

describe("Alchemy precreated worker", () => {
	it.each([
		{doClasses: []},
		{doClasses: ["LiveDO"]},
	])("does not cache deployment responses with DO classes $doClasses", async ({doClasses}) => {
		expect(expression).toBeDefined();
		const script: string = runInNewContext(expression!, {doClasses});
		const executable = script
			.replace('import { DurableObject } from "cloudflare:workers";', "class DurableObject {}")
			.replace("export default", "globalThis.worker =")
			.replaceAll("export class", "class");
		const context = {Response, worker: undefined as {fetch(): Response} | undefined};
		runInNewContext(executable, context);
		const response = context.worker!.fetch();
		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toBe("Alchemy worker is being deployed...");
		for (const name of doClasses)
			expect(script).toContain(`export class ${name} extends DurableObject {}`);
	});
});
