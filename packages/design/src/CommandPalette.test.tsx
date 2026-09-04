import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {FileText} from "lucide-react";
import {describe, expect, it, vi} from "vitest";
import {CommandPalette, type CommandPaletteItem, type CommandPaletteScope} from "./CommandPalette";

const items: readonly CommandPaletteItem[] = [
	{
		value: "sozluk-effect",
		label: "Effect nedir?",
		description: "sözlük · 12 entry",
		group: "Sözlük",
		keywords: ["functional"],
		icon: <FileText />,
	},
	{
		value: "pano-search",
		label: "Arama deneyimi",
		description: "pano · umut",
		group: "Pano",
		shortcut: "↵",
	},
	{value: "disabled", label: "Arşiv", disabled: true, group: "Pano"},
];

const scopedItems: readonly CommandPaletteItem[] = [
	{value: "yazar-ada", label: "ada", scope: "@"},
	{value: "pano-tasarim", label: "tasarım sistemi", scope: "#"},
	{value: "sozluk-ada", label: "ada lovelace", scope: ":"},
];

const scopes: readonly CommandPaletteScope[] = [
	{sigil: "@", label: "kullanıcı"},
	{sigil: "#", label: "pano konusu"},
	{sigil: ":", label: "sözlük başlığı"},
];

const renderPalette = (props: Partial<React.ComponentProps<typeof CommandPalette>> = {}) =>
	render(
		<CommandPalette
			items={items}
			title="kamp.us'ta ara"
			placeholder="ara"
			emptyLabel="sonuç yok"
			defaultOpen
			shortcut={false}
			{...props}
		/>,
	);

describe("CommandPalette", () => {
	it("inherits the shared density ramp instead of exposing a local size axis", () => {
		const stylesheet = "./CommandPalette.css";
		const css = readFileSync(fileURLToPath(new URL(stylesheet, import.meta.url)), "utf8");
		expect(css).toContain("var(--s-2)");
		expect(css).toContain("var(--tap-min)");
		expect(css).toContain("var(--s-8)");
		expect(css).toContain("var(--pop-row-y)");
		expect(css).not.toContain('[data-density="');
		expect(css).not.toContain('data-size="');
	});

	it("renders a labelled modal combobox and grouped results", () => {
		renderPalette();
		const dialog = screen.getByRole("dialog", {name: "kamp.us'ta ara"});
		const input = screen.getByRole("combobox", {name: "kamp.us'ta ara"});
		expect(dialog).not.toBeNull();
		expect(input.getAttribute("aria-controls")).toBeTruthy();
		expect(input.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getAllByRole("option")).toHaveLength(3);
		expect(screen.getByText("Sözlük")).not.toBeNull();
		expect(screen.getByText("Pano")).not.toBeNull();
	});

	it("keeps the input border stable on hover while suppressing programmatic focus rings", () => {
		const stylesheet = "./CommandPalette.css";
		const css = readFileSync(fileURLToPath(new URL(stylesheet, import.meta.url)), "utf8");
		expect(css).toContain("kp-command-palette__search--keyboard-focus");
		expect(css).toContain("border: 0");
		expect(css).toContain("border-bottom: 1px solid var(--border)");
		expect(css).toContain("border-bottom-color: var(--border)");
		expect(css).toContain(
			'.kp-command-palette__search[data-scope="field"][data-part="root"]:focus-within',
		);
		expect(css).toContain("outline: none");
	});

	it("filters labels, descriptions and keywords while exposing its empty state", () => {
		renderPalette();
		const input = screen.getByRole("combobox");
		fireEvent.change(input, {target: {value: "functional"}});
		expect(screen.getAllByRole("option")).toHaveLength(1);
		expect(screen.getByText("Effect nedir?")).not.toBeNull();

		fireEvent.change(input, {target: {value: "bulunamaz"}});
		expect(screen.queryAllByRole("option")).toHaveLength(0);
		expect(screen.getByRole("status").textContent).toBe("sonuç yok");
	});

	it("keeps DOM focus on the input while arrows move the active descendant", async () => {
		renderPalette();
		const input = screen.getByRole("combobox");
		await waitFor(() => expect(document.activeElement).toBe(input));

		fireEvent.keyDown(input, {key: "ArrowDown"});
		const activeId = input.getAttribute("aria-activedescendant");
		expect(activeId).toBe(screen.getAllByRole("option")[1]?.id);
		expect(document.activeElement).toBe(input);

		fireEvent.keyDown(input, {key: "End"});
		expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1]?.id);
	});

	it("selects the active enabled result with Enter and closes by default", async () => {
		const onSelect = vi.fn();
		const onOpenChange = vi.fn();
		renderPalette({onSelect, onOpenChange});
		const input = screen.getByRole("combobox");
		fireEvent.keyDown(input, {key: "Enter"});

		expect(onSelect).toHaveBeenCalledWith(items[0]);
		expect(onOpenChange).toHaveBeenCalledWith(false);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("supports controlled query, loading, result limits and a custom filter", () => {
		const onQueryChange = vi.fn();
		const {rerender} = renderPalette({
			query: "fixed",
			onQueryChange,
			filter: () => true,
			maxResults: 1,
		});
		const input = screen.getByRole("combobox") as HTMLInputElement;
		fireEvent.change(input, {target: {value: "next"}});
		expect(onQueryChange).toHaveBeenCalledWith("next");
		expect(input.value).toBe("fixed");
		expect(screen.getAllByRole("option")).toHaveLength(1);

		rerender(
			<CommandPalette
				items={items}
				title="kamp.us'ta ara"
				placeholder="ara"
				emptyLabel="sonuç yok"
				loadingLabel="aranıyor"
				loading
				open
				shortcut={false}
			/>,
		);
		expect(screen.getByRole("status").textContent).toBe("aranıyor");
	});

	it("opens with Mod+K and does not install the shortcut when disabled", async () => {
		const {unmount} = render(
			<CommandPalette items={items} title="arama" placeholder="ara" emptyLabel="yok" />,
		);
		fireEvent.keyDown(window, {key: "k", metaKey: true});
		expect(await screen.findByRole("dialog")).not.toBeNull();
		unmount();

		render(
			<CommandPalette
				items={items}
				title="arama"
				placeholder="ara"
				emptyLabel="yok"
				disabled
				defaultOpen
				trigger={<button type="button">aç</button>}
			/>,
		);
		fireEvent.keyDown(window, {key: "k", ctrlKey: true});
		expect(screen.queryByRole("dialog")).toBeNull();
		// The trigger stays on the page as a disabled control — a vanishing affordance reads as a
		// broken surface, not as an unavailable one.
		const trigger = screen.getByRole("button", {name: "aç"});
		expect(trigger.hasAttribute("disabled")).toBe(true);
		fireEvent.click(trigger);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("accepts custom result visuals and a footer without changing option semantics", () => {
		renderPalette({footer: <span>ok tuşlarıyla gezin</span>});
		expect(screen.getByText("ok tuşlarıyla gezin")).not.toBeNull();
		expect(screen.getByText("Effect nedir?").closest('[role="option"]')).not.toBeNull();
		expect(
			screen.getByText("Effect nedir?").closest('[role="option"]')?.querySelector("svg"),
		).not.toBeNull();
	});

	it("narrows the default filter to a leading sigil's scope and strips it from the term", () => {
		renderPalette({items: scopedItems, scopes, defaultQuery: ":ada"});
		expect(screen.getAllByRole("option")).toHaveLength(1);
		expect(screen.getByText("ada lovelace")).not.toBeNull();
		expect(screen.queryByText("ada")).toBeNull();
	});

	it("leaves an unsigiled query searching every scope", () => {
		renderPalette({items: scopedItems, scopes, defaultQuery: "ada"});
		expect(screen.getAllByRole("option")).toHaveLength(2);
	});

	it("reports the active scope so a caller can swap its result source", () => {
		const onScopeChange = vi.fn();
		const {rerender} = renderPalette({items: scopedItems, scopes, query: "", onScopeChange});
		expect(onScopeChange).toHaveBeenLastCalledWith(undefined);
		rerender(
			<CommandPalette
				items={scopedItems}
				scopes={scopes}
				query="@ad"
				onScopeChange={onScopeChange}
				title="kamp.us'ta ara"
				placeholder="ara"
				emptyLabel="sonuç yok"
				defaultOpen
				shortcut={false}
			/>,
		);
		expect(onScopeChange).toHaveBeenLastCalledWith("@");
	});

	it("hands a custom filter the sigil-stripped term and does not narrow behind its back", () => {
		const filter = vi.fn(() => true);
		renderPalette({items: scopedItems, scopes, defaultQuery: "#tasarım", filter});
		expect(filter).toHaveBeenCalledWith(expect.objectContaining({value: "yazar-ada"}), "tasarım");
		expect(screen.getAllByRole("option")).toHaveLength(3);
	});

	it("describes the input with a scope legend that marks the active sigil", () => {
		renderPalette({items: scopedItems, scopes, scopeHintLabel: "tüyo", defaultQuery: "@"});
		const input = screen.getByRole("combobox", {name: "kamp.us'ta ara"});
		const legend = document.getElementById(input.getAttribute("aria-describedby") ?? "");
		expect(legend?.textContent).toContain("kullanıcı");
		expect(legend?.textContent).toContain("tüyo");
		const active = legend?.querySelectorAll("[data-active]") ?? [];
		expect(active).toHaveLength(1);
		expect(active[0]?.textContent).toContain("kullanıcı");
	});

	it("omits the scope legend and its description when no scopes are declared", () => {
		renderPalette();
		expect(
			screen.getByRole("combobox", {name: "kamp.us'ta ara"}).getAttribute("aria-describedby"),
		).toBeNull();
	});

	it("marks the variant on the dialog without letting it decide the search icon", () => {
		for (const variant of ["flush", "inset"] as const) {
			for (const showSearchIcon of [true, false]) {
				const {unmount} = renderPalette({variant, showSearchIcon});
				const dialog = screen.getByRole("dialog", {name: "kamp.us'ta ara"});
				expect(dialog.classList.contains(`kp-command-palette--${variant}`)).toBe(true);
				expect(dialog.querySelector(".kp-command-palette__header svg") !== null).toBe(
					showSearchIcon,
				);
				unmount();
			}
		}
	});

	it("shows the search icon by default", () => {
		renderPalette();
		expect(document.querySelector(".kp-command-palette__header svg")).not.toBeNull();
	});

	it("seats the scope legend and the key legend on one footer row", () => {
		renderPalette({
			items: scopedItems,
			scopes,
			scopeHintLabel: "tüyo",
			footer: <span>gezin</span>,
		});
		const footers = document.querySelectorAll(".kp-command-palette__footer");
		expect(footers).toHaveLength(1);
		expect(footers[0]?.querySelector(".kp-command-palette__scopes")).not.toBeNull();
		expect(footers[0]?.querySelector(".kp-command-palette__legend")?.textContent).toBe("gezin");
	});
});
