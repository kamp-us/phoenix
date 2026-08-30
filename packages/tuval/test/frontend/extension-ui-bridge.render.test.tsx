// @vitest-environment jsdom

import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ExtensionUIBridge} from "../../src/frontend-shell/extension-ui-bridge.js";
import type {ExtensionUIBrowserClient} from "../../src/frontend-shell/extension-ui-client.js";
import type {ExtensionUIEvent, ExtensionUIRequest} from "../../src/shared/extension-ui.js";

const scope = {packageName: "fixture-extension", sessionId: "session-one"} as const;

class FakeClient implements ExtensionUIBrowserClient {
	handlers?: Parameters<ExtensionUIBrowserClient["subscribe"]>[0];
	readonly respond = vi.fn(async (request: Parameters<ExtensionUIBrowserClient["respond"]>[0]) => ({
		_tag: "accepted" as const,
		id: request.response.id,
	}));
	readonly cancel = vi.fn(async (request: Parameters<ExtensionUIBrowserClient["cancel"]>[0]) => ({
		_tag: "accepted" as const,
		id: request.id,
	}));
	readonly subscribe = vi.fn((handlers: Parameters<ExtensionUIBrowserClient["subscribe"]>[0]) => {
		this.handlers = handlers;
		return vi.fn();
	});
	emit(event: ExtensionUIEvent): void {
		this.handlers?.event(event);
	}
	open(): void {
		this.handlers?.open();
	}
	snapshot(snapshots: Parameters<NonNullable<typeof this.handlers>["snapshot"]>[0]): void {
		this.handlers?.snapshot(snapshots);
	}
	snapshotFailure(reason: string): void {
		this.handlers?.snapshotFailure(reason);
	}
}

const request = (sequence: number, value: ExtensionUIRequest): ExtensionUIEvent => ({
	_tag: "request",
	sequence,
	scope,
	request: value,
});

const events = {
	select: request(1, {
		type: "extension_ui_request",
		id: "select-one",
		method: "select",
		title: "Bir seçenek seç",
		options: ["alfa", "beta"],
	}),
	confirm: request(2, {
		type: "extension_ui_request",
		id: "confirm-one",
		method: "confirm",
		title: "Devam edilsin mi?",
		message: "Otomatik onay yok.",
	}),
	input: request(3, {
		type: "extension_ui_request",
		id: "input-one",
		method: "input",
		title: "Kısa yanıt",
		placeholder: "Yanıtın",
	}),
	editor: request(4, {
		type: "extension_ui_request",
		id: "editor-one",
		method: "editor",
		title: "Uzun yanıt",
		prefill: "Başlangıç",
	}),
} as const;

beforeEach(() => {
	Reflect.set(Range.prototype, "getClientRects", () => []);
	Reflect.set(Range.prototype, "getBoundingClientRect", () => new DOMRect());
});

afterEach(cleanup);

describe("ExtensionUIBridge", () => {
	it("renders every blocking method, submits one correlated response, and restores focus", async () => {
		const client = new FakeClient();
		render(
			<>
				<button type="button">Önceki odak</button>
				<ExtensionUIBridge client={client} />
			</>,
		);
		const trigger = screen.getByRole("button", {name: "Önceki odak"});
		trigger.focus();

		client.emit(events.select);
		const select = await screen.findByRole("combobox", {name: "Seçim"});
		await waitFor(() => expect(document.activeElement).toBe(select));
		fireEvent.change(select, {target: {value: "beta"}});
		fireEvent.submit(select.closest("form")!);
		await waitFor(() => expect(client.respond).toHaveBeenCalledTimes(1));
		expect(client.respond.mock.calls[0]?.[0]).toEqual({
			scope,
			response: {type: "extension_ui_response", id: "select-one", value: "beta"},
		});
		await waitFor(() => expect(document.activeElement).toBe(trigger));

		client.emit(events.confirm);
		await screen.findByRole("heading", {name: "Devam edilsin mi?"});
		fireEvent.click(screen.getByRole("button", {name: "Reddet"}));
		await waitFor(() => expect(client.respond).toHaveBeenCalledTimes(2));
		expect(client.respond.mock.calls[1]?.[0].response).toEqual({
			type: "extension_ui_response",
			id: "confirm-one",
			confirmed: false,
		});

		client.emit(events.input);
		const input = await screen.findByRole("textbox", {name: "Yanıt"});
		expect((screen.getByRole("button", {name: "Gönder"}) as HTMLButtonElement).disabled).toBe(
			false,
		);
		fireEvent.submit(input.closest("form")!);
		fireEvent.submit(input.closest("form")!);
		await waitFor(() => expect(client.respond).toHaveBeenCalledTimes(3));
		expect(client.respond.mock.calls[2]?.[0].response).toMatchObject({
			id: "input-one",
			value: "",
		});

		client.emit(events.editor);
		const editor = await screen.findByRole("textbox", {name: "Uzun yanıt"});
		expect(editor.getAttribute("aria-multiline")).toBe("true");
		fireEvent.keyDown(editor, {key: "Escape"});
		await waitFor(() => expect(client.cancel).toHaveBeenCalledTimes(1));
		expect(client.cancel).toHaveBeenCalledWith({scope, id: "editor-one"});
	});

	it("bounds transient notices and dismisses each one independently", async () => {
		const client = new FakeClient();
		render(<ExtensionUIBridge client={client} panelVisible={false} />);
		for (let index = 0; index < 10; index += 1) {
			act(() =>
				client.emit({
					_tag: "notify",
					sequence: index + 1,
					scope,
					request: {
						type: "extension_ui_request",
						id: `notice-${index}`,
						method: "notify",
						message: `Bildirim ${index}`,
						notifyType: "info",
					},
				}),
			);
		}
		expect(screen.queryByText("Bildirim 0")).toBeNull();
		expect(screen.queryByText("Bildirim 1")).toBeNull();
		expect(screen.getAllByRole("button", {name: "Bildirimi kapat"})).toHaveLength(8);
		fireEvent.click(screen.getAllByRole("button", {name: "Bildirimi kapat"})[0]!);
		expect(screen.queryByText("Bildirim 2")).toBeNull();
		expect(screen.getAllByRole("button", {name: "Bildirimi kapat"})).toHaveLength(7);
	});

	it("isolates same-key current state across packages and renders stable widget placement", async () => {
		const client = new FakeClient();
		const peerScope = {packageName: "peer-extension", sessionId: "session-one"} as const;
		const siblingScope = {packageName: scope.packageName, sessionId: "session-two"} as const;
		render(<ExtensionUIBridge client={client} />);
		client.handlers?.open();
		client.handlers?.open();
		client.emit({
			_tag: "notify",
			sequence: 1,
			scope,
			request: {
				type: "extension_ui_request",
				id: "notify",
				method: "notify",
				message: "Bilgi hazır",
				notifyType: "info",
			},
		});
		client.emit({
			_tag: "status",
			sequence: 2,
			scope,
			key: "phase",
			text: "çalışıyor",
			replay: false,
		});
		client.emit({
			_tag: "widget",
			sequence: 3,
			scope,
			key: "plan",
			lines: ["bir", "iki"],
			placement: "aboveEditor",
			replay: false,
		});
		client.emit({
			_tag: "status",
			sequence: 4,
			scope: peerScope,
			key: "phase",
			text: "eş paket anahtarı",
			replay: false,
		});
		client.emit({
			_tag: "status",
			sequence: 5,
			scope: siblingScope,
			key: "phase",
			text: "eş oturum anahtarı",
			replay: false,
		});
		client.emit({
			_tag: "widget",
			sequence: 6,
			scope: peerScope,
			key: "plan",
			lines: ["alt satır"],
			placement: "belowEditor",
			replay: false,
		});
		client.emit({
			_tag: "degradation",
			sequence: 7,
			scope,
			id: "title",
			method: "setTitle",
			outcome: "unavailable",
		});
		client.emit({
			_tag: "degradation",
			sequence: 8,
			scope,
			id: "editor-text",
			method: "set_editor_text",
			outcome: "deferred",
		});

		expect(await screen.findByText("Bilgi hazır")).toBeTruthy();
		expect(screen.getByText("çalışıyor")).toBeTruthy();
		expect(screen.getByText("iki")).toBeTruthy();
		expect(screen.getByText("eş paket anahtarı")).toBeTruthy();
		expect(screen.getByText("eş oturum anahtarı")).toBeTruthy();
		const above = screen.getByRole("region", {name: "Editörün üstündeki paket widget'ları"});
		const below = screen.getByRole("region", {name: "Editörün altındaki paket widget'ları"});
		expect(above.textContent).toContain("bir");
		expect(below.textContent).toContain("alt satır");
		expect(above.compareDocumentPosition(below) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toContain("setTitle");
		expect(screen.getByText(/set_editor_text işleme alınmak üzere ertelendi/)).toBeTruthy();
		expect(screen.getAllByText("fixture-extension · session-one").length).toBeGreaterThan(0);

		client.emit({_tag: "unloaded", sequence: 9, scope});
		await waitFor(() => expect(screen.queryByText("çalışıyor")).toBeNull());
		expect(screen.queryByText("iki")).toBeNull();
		expect(screen.getByText("eş paket anahtarı")).toBeTruthy();
		expect(screen.getByText("eş oturum anahtarı")).toBeTruthy();
		expect(screen.getByText("alt satır")).toBeTruthy();
		expect(screen.getByText(/Paket oturumu kaldırıldı/)).toBeTruthy();
	});

	it("preserves hydrated state on connection-open and clears it on an authoritative empty snapshot", async () => {
		const client = new FakeClient();
		render(
			<ExtensionUIBridge
				client={client}
				initialSnapshots={[
					{
						scope,
						statuses: [{key: "hydrated", text: "sunucudan geri yüklendi"}],
						widgets: [{key: "hydrated", lines: ["kalıcı widget"], placement: "aboveEditor"}],
					},
				]}
			/>,
		);
		expect(await screen.findByText("sunucudan geri yüklendi")).toBeTruthy();
		expect(screen.getByText("kalıcı widget")).toBeTruthy();
		client.handlers?.open();
		expect(screen.getByText("sunucudan geri yüklendi")).toBeTruthy();
		expect(screen.getByText("kalıcı widget")).toBeTruthy();
		client.snapshot([]);
		await waitFor(() => expect(screen.queryByText("sunucudan geri yüklendi")).toBeNull());
		expect(screen.queryByText("kalıcı widget")).toBeNull();
	});

	it("keeps retained projection visibly stale until an authoritative snapshot succeeds", async () => {
		const client = new FakeClient();
		render(
			<ExtensionUIBridge
				client={client}
				initialSnapshots={[
					{scope, statuses: [{key: "phase", text: "son doğrulanmış"}], widgets: []},
				]}
			/>,
		);
		client.open();
		expect(screen.getByText("Extension UI · connecting")).toBeTruthy();
		client.snapshotFailure("HTTP 500");
		expect(await screen.findByText("Extension UI · stale")).toBeTruthy();
		expect(screen.getByRole("region", {name: "Son doğrulanmış paket durumu"})).toBeTruthy();
		expect(screen.getByText("son doğrulanmış")).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toContain("gösterilen durum eski");
		client.snapshot([{scope, statuses: [{key: "phase", text: "yetkili yeni"}], widgets: []}]);
		expect(await screen.findByText("Extension UI · connected")).toBeTruthy();
		expect(screen.getByRole("region", {name: "Güncel paket durumu"})).toBeTruthy();
		expect(screen.queryByText("son doğrulanmış")).toBeNull();
		expect(screen.getByText("yetkili yeni")).toBeTruthy();
	});

	it("replaces hydrated state atomically when an authoritative snapshot arrives", async () => {
		const client = new FakeClient();
		render(
			<ExtensionUIBridge
				client={client}
				initialSnapshots={[
					{
						scope,
						statuses: [{key: "hydrated", text: "sunucudan geri yüklendi"}],
						widgets: [
							{
								key: "hydrated",
								lines: ["kalıcı widget"],
								placement: "aboveEditor",
							},
						],
					},
				]}
			/>,
		);
		expect(await screen.findByText("sunucudan geri yüklendi")).toBeTruthy();
		expect(screen.getByText("kalıcı widget")).toBeTruthy();
		client.handlers?.open();
		expect(screen.getByText("sunucudan geri yüklendi")).toBeTruthy();
		expect(screen.getByText("kalıcı widget")).toBeTruthy();
		client.emit({
			_tag: "status",
			sequence: 1,
			scope,
			key: "stale",
			text: "silinmesi gereken durum",
			replay: false,
		});
		client.emit({
			_tag: "widget",
			sequence: 2,
			scope,
			key: "stale",
			lines: ["silinmesi gereken widget"],
			placement: "aboveEditor",
			replay: false,
		});
		client.emit({
			_tag: "notify",
			sequence: 3,
			scope,
			request: {
				type: "extension_ui_request",
				id: "ephemeral",
				method: "notify",
				message: "yeniden oynatılmayan bildirim",
			},
		});
		client.emit(events.confirm);
		expect(await screen.findByRole("dialog")).toBeTruthy();
		client.handlers?.disconnect();
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(screen.getByRole("alert").textContent).toContain("açık diyaloglar iptal edildi");
		expect(client.respond).not.toHaveBeenCalled();

		client.handlers?.open();
		client.snapshot([
			{
				scope,
				statuses: [{key: "phase", text: "son değer"}],
				widgets: [],
			},
		]);
		expect(await screen.findByText("son değer")).toBeTruthy();
		expect(screen.queryByText("sunucudan geri yüklendi")).toBeNull();
		expect(screen.queryByText("kalıcı widget")).toBeNull();
		expect(screen.queryByText("silinmesi gereken durum")).toBeNull();
		expect(screen.queryByText("silinmesi gereken widget")).toBeNull();
		expect(screen.queryByText("yeniden oynatılmayan bildirim")).toBeNull();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(client.respond).not.toHaveBeenCalled();
	});
});
