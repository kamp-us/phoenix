import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {useState} from "react";
import {describe, expect, it} from "vitest";
import {DesignTranslationProvider} from "./i18n";
import {ToastProvider, useToast} from "./Toast";

function Raiser() {
	const {show} = useToast();
	return (
		<button type="button" onClick={() => show({message: "değişiklikler kaydedildi"})}>
			göster
		</button>
	);
}

function raise() {
	fireEvent.click(screen.getByRole("button", {name: "göster"}));
}

describe("ToastProvider — the close button's accessible name", () => {
	it("computes a Turkish name with no catalog injected", async () => {
		render(
			<ToastProvider>
				<Raiser />
			</ToastProvider>,
		);
		raise();

		await waitFor(() => expect(screen.getByRole("button", {name: "bildirimi kapat"})).toBeTruthy());
	});

	it("takes the name from the injected catalog", async () => {
		render(
			<DesignTranslationProvider
				translate={(key) => (key === "ui.toast.close" ? "dismiss notification" : key)}
			>
				<ToastProvider>
					<Raiser />
				</ToastProvider>
			</DesignTranslationProvider>,
		);
		raise();

		await waitFor(() =>
			expect(screen.getByRole("button", {name: "dismiss notification"})).toBeTruthy(),
		);
	});

	it("renames the button when the catalog swaps under a mounted provider", async () => {
		function Swapper() {
			const [en, setEn] = useState(false);
			return (
				<DesignTranslationProvider
					translate={(key) =>
						key === "ui.toast.close" ? (en ? "dismiss notification" : "bildirimi kapat") : key
					}
				>
					<button type="button" onClick={() => setEn(true)}>
						ingilizce
					</button>
					<ToastProvider>
						<Raiser />
					</ToastProvider>
				</DesignTranslationProvider>
			);
		}

		render(<Swapper />);
		raise();
		await waitFor(() => expect(screen.getByRole("button", {name: "bildirimi kapat"})).toBeTruthy());

		fireEvent.click(screen.getByRole("button", {name: "ingilizce"}));
		raise();

		await waitFor(() =>
			expect(screen.getByRole("button", {name: "dismiss notification"})).toBeTruthy(),
		);
		expect(screen.queryByRole("button", {name: "bildirimi kapat"})).toBeNull();
	});
});

// The region's own name stays English — `@zag-js/toast@1.43.0` `dist/toast-group.connect.mjs:26`
// composes it from a `label` option Manti never forwards, so phoenix cannot reach it. Ruled on
// #6777 as an upstream ask rather than an in-repo override. What phoenix must not lose meanwhile is
// the announcement behavior around it, which is what this holds.
describe("ToastProvider — the live region the rename must not disturb", () => {
	it("keeps the polite region wrapping the stack", async () => {
		render(
			<ToastProvider>
				<Raiser />
			</ToastProvider>,
		);
		raise();

		await waitFor(() => expect(screen.getByRole("button", {name: "bildirimi kapat"})).toBeTruthy());

		const region = screen.getByRole("region");
		expect(region.getAttribute("aria-live")).toBe("polite");
		expect(region.getAttribute("aria-atomic")).toBe("false");
		expect(region.classList.contains("kp-toast-region")).toBe(true);
	});
});
