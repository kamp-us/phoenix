// @vitest-environment jsdom

import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {ChatPane} from "../../src/frontend-shell/chat-pane.js";
import {SessionLaunchControls} from "../../src/frontend-shell/session-launch-controls.js";
import type {DiscoveredSession} from "../../src/shared/discovery.js";
import type {
	AttachedLiveSession,
	ControlLiveSessionOutcome,
	LiveSessionControlCommand,
	ModelRef,
	ThinkingLevel,
} from "../../src/shared/live-session.js";

const selected: DiscoveredSession = {
	identity: "pi:alpha" as DiscoveredSession["identity"],
	piSessionId: "alpha",
	createdAt: 1,
	updatedAt: 2,
	cwd: "/work/alpha",
	sourceFile: "/fixtures/alpha.jsonl",
};

const attached: AttachedLiveSession = {
	_tag: "attached",
	sessionId: "alpha",
	revision: 4,
	phase: "turn",
	model: {provider: "anthropic", id: "claude-sonnet"},
	thinkingLevel: "high",
	completion: "running",
	transcript: [],
	archive: {_tag: "complete", hasMore: false},
	lastEventSequence: 8,
	history: {_tag: "ready"},
	runtime: {_tag: "ready"},
	connection: "connected",
	ownership: "exclusive",
	controls: {
		create: true,
		open: true,
		steer: true,
		abort: true,
		setModel: true,
		setThinking: true,
		models: [
			{
				model: {provider: "anthropic", id: "claude-sonnet"},
				name: "Claude Sonnet",
				supportedThinkingLevels: ["medium", "high"],
			},
			{
				model: {provider: "openai", id: "gpt-5"},
				name: "GPT-5",
				supportedThinkingLevels: ["low", "high"],
			},
		],
		thinkingLevels: ["low", "medium", "high"],
	},
};

const acknowledged = (
	command: LiveSessionControlCommand,
	session: AttachedLiveSession = attached,
): ControlLiveSessionOutcome => {
	const base = {
		_tag: "acknowledged" as const,
		command,
		correlationId: `control-${command}`,
		session,
	};
	if (command === "set-model") return {...base, command, value: session.model};
	if (command === "set-thinking") return {...base, command, value: session.thinkingLevel};
	return {...base, command};
};

const refused = (
	command: LiveSessionControlCommand,
	code: Extract<ControlLiveSessionOutcome, {_tag: "refused"}>["code"],
	reason: string,
): ControlLiveSessionOutcome => ({
	_tag: "refused",
	command,
	correlationId: `control-${command}`,
	code,
	reason,
	session: attached,
});

const deferred = <A,>() => {
	let resolve: (value: A) => void = () => undefined;
	const promise = new Promise<A>((done) => {
		resolve = done;
	});
	return {promise, resolve};
};

const pane = (
	overrides: Partial<React.ComponentProps<typeof ChatPane>> = {},
): React.ReactElement => (
	<ChatPane
		selected={selected}
		connection="attached"
		session={attached}
		onClose={vi.fn()}
		onSend={async () => ({ok: true, message: "onaylandı"})}
		onSteer={async () => acknowledged("steer")}
		onAbort={async () => acknowledged("abort")}
		onSetModel={async () => acknowledged("set-model")}
		onSetThinking={async () => acknowledged("set-thinking")}
		{...overrides}
	/>
);

afterEach(cleanup);

describe("Tuval session controls", () => {
	it("keeps create and open pending until acknowledgement, then restores keyboard focus", async () => {
		const createGate = deferred<ControlLiveSessionOutcome>();
		const openGate = deferred<ControlLiveSessionOutcome>();
		const onCreate = vi.fn(() => createGate.promise);
		const onOpen = vi.fn(() => openGate.promise);
		render(<SessionLaunchControls onCreate={onCreate} onOpen={onOpen} />);

		const cwd = screen.getByRole("textbox", {name: "Çalışma dizini"});
		fireEvent.change(cwd, {target: {value: "/work/new"}});
		fireEvent.submit(screen.getByRole("button", {name: "Yeni oturum"}).closest("form")!);
		expect(onCreate).toHaveBeenCalledWith("/work/new");
		expect(screen.getByText("Oluşturma onayı bekleniyor.")).toBeTruthy();
		expect(
			(screen.getByRole("button", {name: "Oluşturuluyor"}) as HTMLButtonElement).disabled,
		).toBe(true);
		expect((cwd as HTMLInputElement).value).toBe("/work/new");

		createGate.resolve(acknowledged("create"));
		await waitFor(() =>
			expect(screen.getByText("Oluşturma pi tarafından onaylandı.")).toBeTruthy(),
		);
		expect((cwd as HTMLInputElement).value).toBe("");
		await waitFor(() => expect(document.activeElement).toBe(cwd));

		const sessionId = screen.getByRole("textbox", {name: "Oturum kimliği"});
		fireEvent.change(sessionId, {target: {value: "existing-id"}});
		fireEvent.submit(screen.getByRole("button", {name: "Oturumu aç"}).closest("form")!);
		expect(onOpen).toHaveBeenCalledWith("existing-id");
		expect((sessionId as HTMLInputElement).value).toBe("existing-id");
		openGate.resolve(acknowledged("open"));
		await waitFor(() => expect(screen.getByText("Açma pi tarafından onaylandı.")).toBeTruthy());
		expect((sessionId as HTMLInputElement).value).toBe("");
		await waitFor(() => expect(document.activeElement).toBe(sessionId));
	});

	it("names create and open refusals without clearing the truthful requested value", async () => {
		render(
			<SessionLaunchControls
				onCreate={async () => refused("create", "timeout", "Pi zamanında yanıt vermedi")}
				onOpen={async () => refused("open", "ownership-refused", "Başka alan sahip")}
			/>,
		);
		const cwd = screen.getByRole("textbox", {name: "Çalışma dizini"});
		fireEvent.change(cwd, {target: {value: "/work/refused"}});
		fireEvent.submit(screen.getByRole("button", {name: "Yeni oturum"}).closest("form")!);
		await screen.findByText(/Oluşturma başarısız \(timeout\): Pi zamanında yanıt vermedi/);
		expect((cwd as HTMLInputElement).value).toBe("/work/refused");

		const sessionId = screen.getByRole("textbox", {name: "Oturum kimliği"});
		fireEvent.change(sessionId, {target: {value: "owned-id"}});
		fireEvent.submit(screen.getByRole("button", {name: "Oturumu aç"}).closest("form")!);
		await screen.findByText(/Açma başarısız \(ownership-refused\): Başka alan sahip/);
		expect((sessionId as HTMLInputElement).value).toBe("owned-id");
	});

	it("renders distinct steer and abort only when the acknowledged contract permits them", () => {
		const view = render(pane());
		expect(screen.getByRole("button", {name: "Yönlendir"})).toBeTruthy();
		expect(screen.getByRole("button", {name: "Durdur"})).toBeTruthy();

		view.rerender(
			pane({
				session: {
					...attached,
					controls: {...attached.controls!, steer: false, abort: false},
				},
			}),
		);
		expect(screen.queryByRole("button", {name: "Yönlendir"})).toBeNull();
		expect(screen.queryByRole("button", {name: "Durdur"})).toBeNull();

		view.rerender(
			pane({
				connection: "disconnected",
				session: {
					...attached,
					_tag: "disconnected",
					connection: "disconnected",
					ownership: "none",
					reason: "Bağlantı koptu",
				},
			}),
		);
		expect(screen.queryByLabelText("Canlı oturum denetimleri")).toBeNull();
	});

	it("uses contract model and compatible thinking options without optimistic selection", async () => {
		const modelGate = deferred<ControlLiveSessionOutcome>();
		const thinkingGate = deferred<ControlLiveSessionOutcome>();
		const onSetModel = vi.fn((_model: ModelRef) => modelGate.promise);
		const onSetThinking = vi.fn((_level: ThinkingLevel) => thinkingGate.promise);
		render(pane({onSetModel, onSetThinking}));

		const model = screen.getByRole("combobox", {name: "Model"}) as HTMLSelectElement;
		const thinking = screen.getByRole("combobox", {name: "Düşünme düzeyi"}) as HTMLSelectElement;
		expect([...model.options].map((option) => option.text)).toEqual(["Claude Sonnet", "GPT-5"]);
		expect([...thinking.options].map((option) => option.value)).toEqual(["medium", "high"]);
		expect(model.value).toBe("anthropic/claude-sonnet");
		expect(thinking.value).toBe("high");

		model.focus();
		fireEvent.change(model, {target: {value: "openai/gpt-5"}});
		expect(onSetModel).toHaveBeenCalledWith({provider: "openai", id: "gpt-5"});
		expect(model.value).toBe("anthropic/claude-sonnet");
		expect(screen.getByText("Model değiştirme onayı bekleniyor.")).toBeTruthy();
		modelGate.resolve(refused("set-model", "unsupported-value", "Model desteklenmiyor"));
		await screen.findByText(/Model değiştirme başarısız \(unsupported-value\)/);
		expect(model.value).toBe("anthropic/claude-sonnet");
		await waitFor(() => expect(document.activeElement).toBe(model));

		thinking.focus();
		fireEvent.change(thinking, {target: {value: "medium"}});
		expect(onSetThinking).toHaveBeenCalledWith("medium");
		expect(thinking.value).toBe("high");
		thinkingGate.resolve(refused("set-thinking", "protocol", "Yanıt eşleşmedi"));
		await screen.findByText(/Düşünme düzeyi değiştirme başarısız \(protocol\)/);
		expect(thinking.value).toBe("high");
		await waitFor(() => expect(document.activeElement).toBe(thinking));
	});

	it("invokes disconnected steer, preserves Composer text, and restores focus", async () => {
		const onSteer = vi.fn(async () => refused("steer", "disconnected", "Bağlantı kesildi"));
		render(pane({onSteer}));
		const editor = await screen.findByRole("textbox", {name: "İstem"});
		const steer = screen.getByRole("button", {name: "Yönlendir"}) as HTMLButtonElement;
		expect(steer.disabled).toBe(true);
		expect(editor.getAttribute("contenteditable")).toBe("true");
		editor.textContent = "Yeni rotayı izle";
		fireEvent.input(editor);
		await waitFor(() => expect(steer.disabled).toBe(false));
		steer.focus();
		fireEvent.click(steer);
		await screen.findByText(/Yönlendirme başarısız \(disconnected\): Bağlantı kesildi/);
		expect(onSteer).toHaveBeenCalledWith("Yeni rotayı izle");
		expect(editor.textContent).toContain("Yeni rotayı izle");
		await waitFor(() => expect(document.activeElement).toBe(steer));
	});

	it("keeps abort pending until acknowledgement and reports thrown protocol failures", async () => {
		const abortGate = deferred<ControlLiveSessionOutcome>();
		const onAbort = vi
			.fn<() => Promise<ControlLiveSessionOutcome>>()
			.mockReturnValueOnce(abortGate.promise)
			.mockRejectedValueOnce(new Error("bozuk zarf"));
		render(pane({onAbort}));
		const abort = screen.getByRole("button", {name: "Durdur"});
		abort.focus();
		fireEvent.click(abort);
		expect(screen.getByText("Durdurma onayı bekleniyor.")).toBeTruthy();
		expect((abort as HTMLButtonElement).disabled).toBe(true);
		abortGate.resolve(acknowledged("abort"));
		await screen.findByText("Durdurma pi tarafından onaylandı.");
		await waitFor(() => expect(document.activeElement).toBe(abort));

		fireEvent.click(abort);
		await screen.findByText(/Durdurma başarısız \(protocol\): bozuk zarf/);
		await waitFor(() => expect(document.activeElement).toBe(abort));
	});
});
