/**
 * The admin console renders English once the reader picks `en` (#7532), nav labels included —
 * those arrive as catalog keys off the module registry, so this is where they resolve.
 */
import {render, screen, waitFor} from "@testing-library/react";
import {lazy} from "react";
import {beforeEach, describe, expect, it} from "vitest";
import {LocaleProvider} from "../i18n";
import {LOCALE_STORAGE_KEY} from "../lib/localeStorage";
import {AdminConsole} from "./AdminConsole";
import {createConsoleRegistry} from "./module-registry.ts";

const registry = createConsoleRegistry();
registry.register({
	id: "bayraklar",
	labelKey: "admin.module.flags",
	panel: lazy(async () => ({default: () => <p data-testid="stub-panel">panel</p>})),
});
registry.register({
	id: "kullanicilar",
	labelKey: "admin.module.kullanicilar",
	panel: lazy(async () => ({default: () => <p>panel</p>})),
});

beforeEach(() => {
	window.localStorage.clear();
});

describe("the admin console renders in the reader's locale", () => {
	it("reads English for an `en` reader, nav labels included", async () => {
		window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
		render(
			<LocaleProvider>
				<AdminConsole registry={registry} />
			</LocaleProvider>,
		);

		await waitFor(() =>
			expect(screen.getByTestId("admin-console").getAttribute("aria-label")).toBe("admin console"),
		);
		expect(screen.getByTestId("admin-nav-bayraklar").textContent).toBe("feature flags");
		expect(screen.getByTestId("admin-nav-kullanicilar").textContent).toBe("users");
	});

	it("reads Turkish when the reader picked nothing", async () => {
		render(
			<LocaleProvider>
				<AdminConsole registry={registry} />
			</LocaleProvider>,
		);

		expect(screen.getByTestId("admin-console").getAttribute("aria-label")).toBe("yönetim konsolu");
		expect(screen.getByTestId("admin-nav-kullanicilar").textContent).toBe("kullanıcılar");
	});
});
