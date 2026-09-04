import {act, render, screen, waitFor} from "@testing-library/react";
import {beforeEach, describe, expect, it} from "vitest";
import {LOCALE_STORAGE_KEY} from "../lib/localeStorage";
import {LocaleProvider, useLocale, useT} from "./LocaleProvider";

function Probe() {
	const {locale, setLocale} = useLocale();
	const t = useT();
	return (
		<div>
			<span data-testid="locale">{locale}</span>
			<span data-testid="skip">{t("layout.skipToContent")}</span>
			<button type="button" onClick={() => setLocale("en")}>
				to-en
			</button>
			<button type="button" onClick={() => setLocale("tr")}>
				to-tr
			</button>
		</div>
	);
}

beforeEach(() => {
	window.localStorage.clear();
	document.documentElement.lang = "";
});

describe("LocaleProvider", () => {
	it("defaults to tr and renders the Turkish catalog", () => {
		render(
			<LocaleProvider>
				<Probe />
			</LocaleProvider>,
		);
		expect(screen.getByTestId("locale").textContent).toBe("tr");
		expect(screen.getByTestId("skip").textContent).toBe("içeriğe geç");
	});

	it("swaps to the English catalog and follows it with <html lang>", async () => {
		render(
			<LocaleProvider>
				<Probe />
			</LocaleProvider>,
		);
		await act(async () => {
			screen.getByText("to-en").click();
		});
		await waitFor(() => expect(screen.getByTestId("skip").textContent).toBe("skip to content"));
		expect(document.documentElement.lang).toBe("en");
	});

	it("persists the choice under kampus.locale and rehydrates it on a fresh mount", async () => {
		const first = render(
			<LocaleProvider>
				<Probe />
			</LocaleProvider>,
		);
		await act(async () => {
			screen.getByText("to-en").click();
		});
		await waitFor(() => expect(screen.getByTestId("skip").textContent).toBe("skip to content"));
		expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
		first.unmount();

		render(
			<LocaleProvider>
				<Probe />
			</LocaleProvider>,
		);
		expect(screen.getByTestId("locale").textContent).toBe("en");
		await waitFor(() => expect(screen.getByTestId("skip").textContent).toBe("skip to content"));
	});

	it("comes back to Turkish, catalog and lang together", async () => {
		window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
		render(
			<LocaleProvider>
				<Probe />
			</LocaleProvider>,
		);
		await waitFor(() => expect(document.documentElement.lang).toBe("en"));
		await act(async () => {
			screen.getByText("to-tr").click();
		});
		expect(screen.getByTestId("skip").textContent).toBe("içeriğe geç");
		expect(document.documentElement.lang).toBe("tr");
	});

	it("falls back to the Turkish catalog with no provider above it", () => {
		render(<Probe />);
		expect(screen.getByTestId("locale").textContent).toBe("tr");
		expect(screen.getByTestId("skip").textContent).toBe("içeriğe geç");
	});
});
