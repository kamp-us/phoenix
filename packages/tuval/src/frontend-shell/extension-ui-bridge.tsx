import {Composer, useComposerEditor} from "@kampus/composer";
import type {FormEvent, KeyboardEvent as ReactKeyboardEvent} from "react";
import {useEffect, useMemo, useRef, useState} from "react";
import {Button} from "../../../../apps/web/src/components/ui/Button.js";
import {Card, Surface} from "../../../../apps/web/src/components/ui/Card.js";
import type {
	ExtensionUIEvent,
	ExtensionUIRequest,
	ExtensionUIResponse,
	ExtensionUIScope,
} from "../shared/extension-ui.js";
import {type ExtensionUIBrowserClient, extensionUIBrowserClient} from "./extension-ui-client.js";

type BlockingRequest = Extract<
	ExtensionUIRequest,
	{method: "select" | "confirm" | "input" | "editor"}
>;

interface PendingDialog {
	readonly key: string;
	readonly sequence: number;
	readonly scope: ExtensionUIScope;
	readonly request: BlockingRequest;
	readonly settling: boolean;
}

interface Notice {
	readonly key: string;
	readonly tone: "info" | "warning" | "error";
	readonly scope?: ExtensionUIScope;
	readonly text: string;
}

interface StatusView {
	readonly scope: ExtensionUIScope;
	readonly key: string;
	readonly text: string;
}

interface WidgetView {
	readonly scope: ExtensionUIScope;
	readonly key: string;
	readonly lines: ReadonlyArray<string>;
	readonly placement: "aboveEditor" | "belowEditor";
}

interface BridgeState {
	readonly connection: "connecting" | "connected" | "disconnected" | "malformed";
	readonly dialogs: ReadonlyArray<PendingDialog>;
	readonly notices: ReadonlyArray<Notice>;
	readonly statuses: ReadonlyMap<string, StatusView>;
	readonly widgets: ReadonlyMap<string, WidgetView>;
}

const initialState = (): BridgeState => ({
	connection: "connecting",
	dialogs: [],
	notices: [],
	statuses: new Map(),
	widgets: new Map(),
});

export const extensionUIScopeKey = ({packageName, sessionId}: ExtensionUIScope): string =>
	`${packageName.length}:${packageName}${sessionId.length}:${sessionId}`;
const requestKey = (scope: ExtensionUIScope, id: string): string =>
	`${extensionUIScopeKey(scope)}:${id}`;
const stateKey = (scope: ExtensionUIScope, key: string): string =>
	`${extensionUIScopeKey(scope)}:${key}`;
const sameScope = (left: ExtensionUIScope, right: ExtensionUIScope): boolean =>
	left.packageName === right.packageName && left.sessionId === right.sessionId;

const appendNotice = (state: BridgeState, notice: Notice): BridgeState => ({
	...state,
	notices: [...state.notices.filter(({key}) => key !== notice.key), notice].slice(-8),
});

export const reduceExtensionUIEvent = (
	state: BridgeState,
	event: ExtensionUIEvent,
): BridgeState => {
	if (event._tag === "request") {
		if (
			event.request.method !== "select" &&
			event.request.method !== "confirm" &&
			event.request.method !== "input" &&
			event.request.method !== "editor"
		) {
			return appendNotice(state, {
				key: `missing:${requestKey(event.scope, event.request.id)}`,
				tone: "error",
				scope: event.scope,
				text: `${event.request.method} için kullanılabilir bir diyalog yok; istek onaylanmadı.`,
			});
		}
		const key = requestKey(event.scope, event.request.id);
		if (state.dialogs.some((dialog) => dialog.key === key)) return state;
		return {
			...state,
			dialogs: [
				...state.dialogs,
				{
					key,
					sequence: event.sequence,
					scope: event.scope,
					request: event.request,
					settling: false,
				},
			].sort((left, right) => left.sequence - right.sequence),
		};
	}
	if (event._tag === "settled") {
		const key = requestKey(event.scope, event.id);
		return appendNotice(
			{...state, dialogs: state.dialogs.filter((dialog) => dialog.key !== key)},
			{
				key: `settled:${key}`,
				tone: event.outcome === "responded" ? "info" : "warning",
				scope: event.scope,
				text: `${event.method} isteği ${event.outcome} sonucu ile kapandı.`,
			},
		);
	}
	if (event._tag === "notify") {
		return appendNotice(state, {
			key: `notify:${requestKey(event.scope, event.request.id)}`,
			tone: event.request.notifyType ?? "info",
			scope: event.scope,
			text: event.request.message,
		});
	}
	if (event._tag === "degradation") {
		return appendNotice(state, {
			key: `degradation:${requestKey(event.scope, event.id)}`,
			tone: event.outcome === "unavailable" ? "error" : "warning",
			scope: event.scope,
			text:
				event.outcome === "unavailable"
					? `${event.method} bu tarayıcıda kullanılamıyor; işlem uygulanmadı.`
					: `${event.method} işleme alınmak üzere ertelendi; otomatik uygulanmadı.`,
		});
	}
	if (event._tag === "status") {
		const key = stateKey(event.scope, event.key);
		const statuses = new Map(state.statuses);
		if (event.text === undefined) statuses.delete(key);
		else statuses.set(key, {scope: event.scope, key: event.key, text: event.text});
		return {...state, statuses};
	}
	if (event._tag === "widget") {
		const key = stateKey(event.scope, event.key);
		const widgets = new Map(state.widgets);
		if (event.lines === undefined) widgets.delete(key);
		else {
			widgets.set(key, {
				scope: event.scope,
				key: event.key,
				lines: event.lines,
				placement: event.placement,
			});
		}
		return {...state, widgets};
	}
	return appendNotice(
		{
			...state,
			dialogs: state.dialogs.filter((dialog) => !sameScope(dialog.scope, event.scope)),
			statuses: new Map(
				[...state.statuses].filter(([, value]) => !sameScope(value.scope, event.scope)),
			),
			widgets: new Map(
				[...state.widgets].filter(([, value]) => !sameScope(value.scope, event.scope)),
			),
		},
		{
			key: `unloaded:${extensionUIScopeKey(event.scope)}`,
			tone: "warning",
			scope: event.scope,
			text: "Paket oturumu kaldırıldı; açık istekler ve güncel görünüm temizlendi.",
		},
	);
};

const ScopeAttribution = ({scope}: {readonly scope: ExtensionUIScope}) => (
	<span className="extension-ui__scope">
		{scope.packageName} · {scope.sessionId}
	</span>
);

interface DialogProps {
	readonly dialog: PendingDialog;
	readonly settle: (response?: ExtensionUIResponse) => Promise<void>;
}

const DialogForm = ({dialog, settle}: DialogProps) => {
	const [value, setValue] = useState(
		dialog.request.method === "select"
			? (dialog.request.options.at(0) ?? "")
			: dialog.request.method === "editor"
				? (dialog.request.prefill ?? "")
				: "",
	);
	const [editorReady, setEditorReady] = useState(dialog.request.method !== "editor");
	const editor = useComposerEditor();
	const dialogRef = useRef<HTMLDivElement>(null);
	const restoreFocus = useRef<HTMLElement | null>(null);

	useEffect(() => {
		restoreFocus.current =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		requestAnimationFrame(() => {
			const focusable = dialogRef.current?.querySelector<HTMLElement>(
				"select, input, [contenteditable='true'], button",
			);
			focusable?.focus();
		});
		return () => restoreFocus.current?.focus();
	}, []);

	useEffect(() => {
		if (dialog.request.method !== "editor" || editor === null) return;
		editor.setContent(dialog.request.prefill ?? "");
		setValue(editor.getMarkdown());
		setEditorReady(true);
		const sync = () => setValue(editor.getMarkdown());
		editor.editor.on("update", sync);
		editor.editor.setOptions({
			editorProps: {
				attributes: {role: "textbox", "aria-label": dialog.request.title, "aria-multiline": "true"},
			},
		});
		return () => {
			editor.editor.off("update", sync);
		};
	}, [dialog.request, editor]);

	const valueIsValid =
		dialog.request.method === "select"
			? dialog.request.options.includes(value)
			: dialog.request.method === "editor"
				? editorReady
				: true;

	const submit = (event: FormEvent<HTMLFormElement>): void => {
		event.preventDefault();
		if (!valueIsValid) return;
		if (dialog.request.method === "confirm") {
			void settle({type: "extension_ui_response", id: dialog.request.id, confirmed: true});
		} else {
			void settle({type: "extension_ui_response", id: dialog.request.id, value});
		}
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			void settle();
			return;
		}
		if (event.key !== "Tab") return;
		const focusable = [
			...(dialogRef.current?.querySelectorAll<HTMLElement>(
				"select, input, [contenteditable='true'], button:not(:disabled)",
			) ?? []),
		];
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable.at(-1);
		if (first === undefined || last === undefined) return;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	return (
		<div className="extension-ui__backdrop" role="presentation">
			<div
				className="extension-ui__dialog-shell"
				role="dialog"
				aria-modal="true"
				aria-labelledby="extension-ui-dialog-title"
				ref={dialogRef}
				onKeyDown={onKeyDown}
			>
				<Surface
					as="div"
					className="extension-ui__dialog"
					tone="default"
					elevation="overlay"
					radius="lg"
					padding="lg"
					border
				>
					<ScopeAttribution scope={dialog.scope} />
					<h2 id="extension-ui-dialog-title">{dialog.request.title}</h2>
					{dialog.request.method === "confirm" ? <p>{dialog.request.message}</p> : null}
					<form onSubmit={submit}>
						{dialog.request.method === "select" ? (
							<label>
								<span>Seçim</span>
								<select value={value} onChange={(event) => setValue(event.currentTarget.value)}>
									{dialog.request.options.map((option) => (
										<option key={option}>{option}</option>
									))}
								</select>
							</label>
						) : dialog.request.method === "input" ? (
							<label>
								<span>Yanıt</span>
								<input
									value={value}
									placeholder={dialog.request.placeholder}
									onChange={(event) => setValue(event.currentTarget.value)}
								/>
							</label>
						) : dialog.request.method === "editor" ? (
							<div className="extension-ui__field">
								<span>Yanıt</span>
								<Composer composer={editor} className="extension-ui__editor" />
							</div>
						) : null}
						<div className="extension-ui__actions">
							<Button
								type="button"
								variant="secondary"
								disabled={dialog.settling}
								onClick={() => void settle()}
							>
								İptal
							</Button>
							{dialog.request.method === "confirm" ? (
								<Button
									type="button"
									variant="secondary"
									disabled={dialog.settling}
									onClick={() =>
										void settle({
											type: "extension_ui_response",
											id: dialog.request.id,
											confirmed: false,
										})
									}
								>
									Reddet
								</Button>
							) : null}
							<Button type="submit" variant="primary" disabled={dialog.settling || !valueIsValid}>
								{dialog.settling
									? "Gönderiliyor"
									: dialog.request.method === "confirm"
										? "Onayla"
										: "Gönder"}
							</Button>
						</div>
					</form>
					<p className="extension-ui__hint">
						<kbd>Esc</kbd> iptal eder · <kbd>Enter</kbd> gönderir
					</p>
				</Surface>
			</div>
		</div>
	);
};

const Widget = ({widget}: {readonly widget: WidgetView}) => (
	<div className="extension-ui__widget">
		<ScopeAttribution scope={widget.scope} />
		<strong>{widget.key}</strong>
		{widget.lines.map((line, index) => (
			<p key={`${index}:${line}`}>{line}</p>
		))}
	</div>
);

export function ExtensionUIBridge({
	client = extensionUIBrowserClient,
}: {
	readonly client?: ExtensionUIBrowserClient;
}) {
	const [state, setState] = useState<BridgeState>(initialState);
	const submitted = useRef(new Set<string>());
	const active = state.dialogs.at(0);
	const currentOrder = (left: StatusView | WidgetView, right: StatusView | WidgetView) =>
		extensionUIScopeKey(left.scope).localeCompare(extensionUIScopeKey(right.scope)) ||
		left.key.localeCompare(right.key);
	const statuses = useMemo(() => [...state.statuses.values()].sort(currentOrder), [state.statuses]);
	const widgets = useMemo(() => [...state.widgets.values()].sort(currentOrder), [state.widgets]);
	const aboveWidgets = widgets.filter(({placement}) => placement === "aboveEditor");
	const belowWidgets = widgets.filter(({placement}) => placement === "belowEditor");

	useEffect(
		() =>
			client.subscribe({
				open: () =>
					setState((current) => ({
						...current,
						connection: "connected",
						dialogs: [],
						notices: [],
						statuses: new Map(),
						widgets: new Map(),
					})),
				event: (event) => setState((current) => reduceExtensionUIEvent(current, event)),
				disconnect: () =>
					setState((current) =>
						appendNotice(
							{...current, connection: "disconnected", dialogs: []},
							{
								key: "connection:disconnected",
								tone: "error",
								text: "Extension UI bağlantısı kesildi; açık diyaloglar iptal edildi. Güncel durum yeniden bağlanınca geri yüklenir.",
							},
						),
					),
				malformed: () =>
					setState((current) =>
						appendNotice(
							{...current, connection: "malformed"},
							{
								key: "connection:malformed",
								tone: "error",
								text: "Extension UI olayı okunamadı; hiçbir istek otomatik onaylanmadı.",
							},
						),
					),
			}),
		[client],
	);

	const settle = async (dialog: PendingDialog, response?: ExtensionUIResponse): Promise<void> => {
		if (submitted.current.has(dialog.key)) return;
		submitted.current.add(dialog.key);
		setState((current) => ({
			...current,
			dialogs: current.dialogs.map((candidate) =>
				candidate.key === dialog.key ? {...candidate, settling: true} : candidate,
			),
		}));
		try {
			const outcome =
				response === undefined
					? await client.cancel({scope: dialog.scope, id: dialog.request.id})
					: await client.respond({scope: dialog.scope, response});
			setState((current) =>
				appendNotice(
					{...current, dialogs: current.dialogs.filter(({key}) => key !== dialog.key)},
					{
						key: `response:${dialog.key}`,
						tone: outcome._tag === "accepted" || outcome._tag === "duplicate" ? "info" : "warning",
						scope: dialog.scope,
						text: `${dialog.request.method} yanıtı ${outcome._tag} sonucu ile kaydedildi.`,
					},
				),
			);
		} catch (error) {
			submitted.current.delete(dialog.key);
			setState((current) =>
				appendNotice(
					{
						...current,
						dialogs: current.dialogs.map((candidate) =>
							candidate.key === dialog.key ? {...candidate, settling: false} : candidate,
						),
					},
					{
						key: `response-error:${dialog.key}`,
						tone: "error",
						scope: dialog.scope,
						text:
							error instanceof Error ? error.message : "Yanıt gönderilemedi; istek açık tutuldu.",
					},
				),
			);
		}
	};

	return (
		<section className="extension-ui" aria-label="Paket extension UI">
			<div
				className="extension-ui__connection"
				data-state={state.connection}
				role="status"
				aria-live="polite"
			>
				Extension UI · {state.connection}
			</div>
			{statuses.length === 0 && widgets.length === 0 ? null : (
				<Card as="section" className="extension-ui__current" aria-label="Güncel paket durumu">
					{aboveWidgets.length === 0 ? null : (
						<section
							className="extension-ui__widget-zone"
							data-placement="aboveEditor"
							aria-label="Editörün üstündeki paket widget'ları"
						>
							<h3>Editörün üstü</h3>
							{aboveWidgets.map((widget) => (
								<Widget key={stateKey(widget.scope, widget.key)} widget={widget} />
							))}
						</section>
					)}
					{statuses.length === 0 ? null : (
						<section className="extension-ui__status-zone" aria-label="Paket durumları">
							{statuses.map((status) => (
								<p key={stateKey(status.scope, status.key)}>
									<ScopeAttribution scope={status.scope} />
									<strong>{status.key}</strong>
									<span>{status.text}</span>
								</p>
							))}
						</section>
					)}
					{belowWidgets.length === 0 ? null : (
						<section
							className="extension-ui__widget-zone"
							data-placement="belowEditor"
							aria-label="Editörün altındaki paket widget'ları"
						>
							<h3>Editörün altı</h3>
							{belowWidgets.map((widget) => (
								<Widget key={stateKey(widget.scope, widget.key)} widget={widget} />
							))}
						</section>
					)}
				</Card>
			)}
			<div className="extension-ui__notices" aria-live="polite">
				{state.notices.map((notice) => (
					<Card
						as="section"
						key={notice.key}
						data-tone={notice.tone}
						role={notice.tone === "error" ? "alert" : "status"}
					>
						{notice.scope === undefined ? null : <ScopeAttribution scope={notice.scope} />}
						<p>{notice.text}</p>
					</Card>
				))}
			</div>
			{active === undefined ? null : (
				<DialogForm
					key={active.key}
					dialog={active}
					settle={(response) => settle(active, response)}
				/>
			)}
		</section>
	);
}
