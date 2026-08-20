import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {CONFIG_PATH} from "../document.ts";
import {loadConfig, resolve} from "../load.ts";
import {UNREADABLE_CODEOWNERS, unreadableCodeownersKey} from "./control-plane.ts";

const resolved = (text: string) =>
	resolve(loadConfig({_tag: "Text", text}), unreadableCodeownersKey);

describe(UNREADABLE_CODEOWNERS, () => {
	it("ships by default — a repo where CODEOWNERS is decoration must not deadlock on a read fault", () => {
		expect(unreadableCodeownersKey.shippedDefault).toBe("ship");
		expect(resolved("{}")).toEqual({
			_tag: "Default",
			value: "ship",
			reason: `${CONFIG_PATH} declares no \`${UNREADABLE_CODEOWNERS}\``,
		});
	});

	it("takes the strict value a repo declares", () => {
		expect(resolved('{"unreadableCodeowners": "refuse"}')).toEqual({
			_tag: "Declared",
			value: "refuse",
		});
	});

	it("refuses a value off the vocabulary rather than falling back to the default", () => {
		expect(resolved('{"unreadableCodeowners": "yes"}')._tag).toBe("Malformed");
		expect(resolved('{"unreadableCodeowners": true}')._tag).toBe("Malformed");
	});
});

describe(`phoenix's own ${CONFIG_PATH}`, () => {
	// The shipped default is the LOOSE value, which is the one departure from the "reproduce today's
	// behaviour" rule in .patterns/fabrika-config-key-groups.md. It is only safe because it is
	// paired: this repo declares the strict value, and this test is what holds it there.
	it("resolves refuse-on-unreadable — here CODEOWNERS IS the control-plane gate (#4216)", () => {
		const text = readFileSync(
			fileURLToPath(new URL(`../../../../../${CONFIG_PATH}`, import.meta.url)),
			"utf8",
		);
		expect(resolved(text)).toEqual({_tag: "Declared", value: "refuse"});
	});
});
