import {Composer, useComposerEditor} from "@kampus/composer";
import type {FormEvent, KeyboardEvent, ReactNode} from "react";
import {useEffect, useRef, useState} from "react";
import {Button} from "../../../../apps/web/src/components/ui/Button.js";
import {Card, Surface} from "../../../../apps/web/src/components/ui/Card.js";
import {EmptyState} from "../../../../apps/web/src/components/ui/EmptyState.js";
import type {DiscoveredSession} from "../shared/discovery.js";
import type {
	ControlLiveSessionOutcome,
	LiveSessionView,
	LiveTranscriptEntry,
	ModelRef,
	ThinkingLevel,
	TranscriptContent,
} from "../shared/live-session.js";
import {sessionTitle} from "./canvas-adapter.js";

export type PaneConnection =
	| "pending"
	| "attached"
	| "reconnecting"
	| "stopped"
	| "refused"
	| "disconnected"
	| "malformed";

export interface SendResult {
	readonly ok: boolean;
	readonly message: string;
}

export interface ChatPaneProps {
	readonly selected: DiscoveredSession;
	readonly connection: PaneConnection;
	readonly session: LiveSessionView | null;
	readonly message?: string;
	readonly onClose: () => void;
	readonly onReconnect?: () => void;
	readonly onSend: (text: string) => Promise<SendResult>;
	readonly onSteer?: (text: string) => Promise<ControlLiveSessionOutcome>;
	readonly onAbort?: () => Promise<ControlLiveSessionOutcome>;
	readonly onSetModel?: (model: ModelRef) => Promise<ControlLiveSessionOutcome>;
	readonly onSetThinking?: (level: ThinkingLevel) => Promise<ControlLiveSessionOutcome>;
}

const transcriptStatus: Readonly<Record<LiveTranscriptEntry["status"], string>> = {
	complete: "Tamamlandı",
	streaming: "Yazılıyor",
	running: "Çalışıyor",
	error: "Hata",
	aborted: "Durduruldu",
};

const completionLabel: Readonly<Record<LiveSessionView["completion"], string>> = {
	idle: "Hazır",
	running: "Yanıt üretiliyor",
	complete: "Tur tamamlandı",
	error: "Tur hatayla sonlandı",
	aborted: "Tur durduruldu",
	disconnected: "Bağlantı kesildi",
};

const phaseLabel: Readonly<Record<LiveSessionView["phase"], string>> = {
	idle: "Beklemede",
	turn: "Tur çalışıyor",
	compaction: "Bağlam düzenleniyor",
	branch_summary: "Dal özeti hazırlanıyor",
	retry: "Yeniden deneniyor",
};

const roleLabel: Readonly<Record<LiveTranscriptEntry["role"], string>> = {
	user: "Sen",
	assistant: "Pi",
	tool: "Araç",
};

const renderContent = (content: TranscriptContent, index: number): ReactNode => {
	if (content.type === "text") return <p key={index}>{content.text}</p>;
	if (content.type === "thinking") {
		return (
			<details key={index} className="transcript-thinking">
				<summary>{content.redacted === true ? "Gizli düşünce" : "Düşünce"}</summary>
				{content.redacted === true ? null : <p>{content.thinking}</p>}
			</details>
		);
	}
	if (content.type === "toolCall") {
		return (
			<details key={index} className="transcript-tool">
				<summary>{content.toolName}</summary>
				<pre>{JSON.stringify(content.input, null, 2)}</pre>
			</details>
		);
	}
	return <p key={index}>Görsel · {content.mimeType}</p>;
};

const TranscriptEntry = ({entry}: {readonly entry: LiveTranscriptEntry}) => (
	<Card
		as="article"
		tone={entry.role === "user" ? "raised" : "default"}
		className="transcript-entry"
		data-role={entry.role}
		aria-label={`${roleLabel[entry.role]} iletisi`}
	>
		<header>
			<strong>{roleLabel[entry.role]}</strong>
			<span>{transcriptStatus[entry.status]}</span>
		</header>
		<div className="transcript-entry__content">
			{entry.content.map((content, index) => renderContent(content, index))}
		</div>
	</Card>
);

const connectionCopy = (
	connection: PaneConnection,
	message: string | undefined,
): {readonly tone: string; readonly title: string; readonly detail: string} => {
	if (connection === "pending") {
		return {tone: "loading", title: "Bağlanıyor", detail: "Oturum sahipliği doğrulanıyor."};
	}
	if (connection === "reconnecting") {
		return {
			tone: "danger",
			title: "Bağlantı kesildi · yeniden bağlanıyor",
			detail: message ?? "Son doğrulanmış konuşma korunurken bağlantı yenileniyor.",
		};
	}
	if (connection === "stopped") {
		return {
			tone: "danger",
			title: "Yeniden bağlanma durdu",
			detail: message ?? "Üç deneme tamamlandı; son doğrulanmış konuşma korunuyor.",
		};
	}
	if (connection === "refused") {
		return {
			tone: "danger",
			title: "Oturum açılamadı",
			detail: message ?? "Bu oturum başka bir çalışma alanı tarafından kullanılıyor.",
		};
	}
	if (connection === "malformed") {
		return {
			tone: "danger",
			title: "Canlı akış okunamadı",
			detail: message ?? "Son doğrulanmış konuşma korunuyor; yeni olaylar gösterilmiyor.",
		};
	}
	if (connection === "disconnected") {
		return {
			tone: "danger",
			title: "Bağlantı kesildi",
			detail: message ?? "Son doğrulanmış konuşma korunuyor.",
		};
	}
	return {tone: "ready", title: "Canlı", detail: "Oturum olayları sırayla alınıyor."};
};

const controlActionLabel = {
	steer: "Yönlendirme",
	abort: "Durdurma",
	"set-model": "Model değiştirme",
	"set-thinking": "Düşünme düzeyi değiştirme",
} as const;

export function ChatPane({
	selected,
	connection,
	session,
	message,
	onClose,
	onReconnect = () => undefined,
	onSend,
	onSteer,
	onAbort,
	onSetModel,
	onSetThinking,
}: ChatPaneProps) {
	const [sending, setSending] = useState(false);
	const [composerValue, setComposerValue] = useState("");
	const [pendingControl, setPendingControl] = useState<keyof typeof controlActionLabel | null>(
		null,
	);
	const [controlStatus, setControlStatus] = useState<{
		readonly danger: boolean;
		readonly text: string;
	} | null>(null);
	const [sendStatus, setSendStatus] = useState<{
		readonly tone: string;
		readonly text: string;
	} | null>(null);
	const transcriptEnd = useRef<HTMLDivElement>(null);
	const composer = useComposerEditor();
	const connectionStatus = connectionCopy(connection, message);
	const attachedSession =
		connection === "attached" && session?._tag === "attached" ? session : null;
	const attached = attachedSession !== null;
	const controls = attachedSession?.controls;
	const acknowledgedModel = attachedSession?.model;
	const selectedModel = controls?.models.find(
		({model}) =>
			acknowledgedModel !== undefined &&
			model.provider === acknowledgedModel.provider &&
			model.id === acknowledgedModel.id,
	);
	const thinkingLevels =
		selectedModel === undefined
			? (controls?.thinkingLevels ?? [])
			: (controls?.thinkingLevels.filter((level) =>
					selectedModel.supportedThinkingLevels.includes(level),
				) ?? []);
	const canSend = attached && !sending && pendingControl === null;
	const composerText = (): string => composerValue.trim();

	useEffect(() => {
		setSending(false);
		setPendingControl(null);
		setControlStatus(null);
		setSendStatus(null);
	}, [selected.identity]);

	useEffect(() => {
		if (composer === null) return;
		const syncComposerValue = () => setComposerValue(composer.getMarkdown());
		composer.editor.on("update", syncComposerValue);
		syncComposerValue();
		return () => {
			composer.editor.off("update", syncComposerValue);
		};
	}, [composer]);

	useEffect(() => {
		composer?.editor.setOptions({
			editorProps: {
				attributes: {
					role: "textbox",
					"aria-label": "İstem",
					"aria-multiline": "true",
				},
			},
		});
	}, [composer]);

	useEffect(() => {
		transcriptEnd.current?.scrollIntoView?.({block: "nearest"});
	}, [session?.revision, session?.transcript.length]);

	const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		const text = composerText();
		if (!canSend || text.length === 0) return;
		setSending(true);
		setSendStatus({tone: "loading", text: "Gönderiliyor; onay bekleniyor."});
		try {
			const result = await onSend(text);
			if (result.ok) {
				composer?.setContent("");
				setSendStatus({tone: "ready", text: result.message});
			} else {
				setSendStatus({tone: "danger", text: result.message});
			}
		} catch (error) {
			setSendStatus({
				tone: "danger",
				text: error instanceof Error ? error.message : "İleti gönderilemedi.",
			});
		} finally {
			setSending(false);
		}
	};

	const runControl = async (
		action: keyof typeof controlActionLabel,
		request: () => Promise<ControlLiveSessionOutcome>,
	): Promise<ControlLiveSessionOutcome | undefined> => {
		if (pendingControl !== null || !attached) return undefined;
		const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setPendingControl(action);
		setControlStatus({danger: false, text: `${controlActionLabel[action]} onayı bekleniyor.`});
		try {
			const outcome = await request();
			setControlStatus(
				outcome._tag === "acknowledged"
					? {danger: false, text: `${controlActionLabel[action]} pi tarafından onaylandı.`}
					: {
							danger: true,
							text: `${controlActionLabel[action]} başarısız (${outcome.code}): ${outcome.reason}`,
						},
			);
			return outcome;
		} catch (error) {
			setControlStatus({
				danger: true,
				text: `${controlActionLabel[action]} başarısız (protocol): ${
					error instanceof Error ? error.message : "Denetim yanıtı alınamadı."
				}`,
			});
			return undefined;
		} finally {
			setPendingControl(null);
			requestAnimationFrame(() => requestAnimationFrame(() => trigger?.focus()));
		}
	};

	const handleComposerKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
		if (
			event.key !== "Enter" ||
			event.shiftKey ||
			!(event.target instanceof HTMLElement) ||
			event.target.closest('[contenteditable="true"]') === null
		) {
			return;
		}
		event.preventDefault();
		event.currentTarget.requestSubmit();
	};

	return (
		<Surface
			as="aside"
			className="chat-pane"
			aria-labelledby="chat-title"
			data-connection={connection}
			tone="default"
			elevation="overlay"
			radius="lg"
			padding="md"
			border
		>
			<header className="chat-pane__header">
				<div>
					<p className="chat-pane__eyebrow">Canlı oturum</p>
					<h2 id="chat-title">{sessionTitle(selected.cwd)}</h2>
					<p className="chat-pane__path">{selected.cwd}</p>
				</div>
				<Button variant="secondary" type="button" onClick={onClose}>
					Sohbeti kapat
				</Button>
			</header>

			<Surface
				className="chat-connection"
				data-tone={connectionStatus.tone}
				role={connectionStatus.tone === "danger" ? "alert" : "status"}
				aria-live={connectionStatus.tone === "danger" ? "assertive" : "polite"}
				tone="raised"
				radius="md"
				padding="sm"
				border
			>
				<strong>{connectionStatus.title}</strong>
				<span>{connectionStatus.detail}</span>
				{connection === "stopped" ? (
					<Button type="button" variant="secondary" onClick={onReconnect}>
						Yeniden bağlan
					</Button>
				) : null}
			</Surface>

			{session === null ? (
				<EmptyState
					className="chat-empty"
					title="Konuşma bekleniyor"
					description="Bağlantı doğrulanınca mevcut konuşma burada açılacak."
				/>
			) : (
				<>
					<Surface
						className="session-phase"
						data-completion={session.completion}
						tone="raised"
						radius="md"
						padding="sm"
						border
					>
						<strong>{completionLabel[session.completion]}</strong>
						<span>{phaseLabel[session.phase]}</span>
						<span>
							{session.model.provider} · {session.model.id} · {session.thinkingLevel}
						</span>
					</Surface>
					{controls === undefined ? null : (
						<section className="session-controls" aria-label="Canlı oturum denetimleri">
							<div className="session-controls__selectors">
								{controls.setModel && controls.models.length > 0 && onSetModel !== undefined ? (
									<label>
										<span>Model</span>
										<select
											aria-label="Model"
											value={`${session.model.provider}/${session.model.id}`}
											disabled={pendingControl !== null}
											onChange={(event) => {
												const candidate = controls.models.find(
													({model}) =>
														`${model.provider}/${model.id}` === event.currentTarget.value,
												);
												if (candidate !== undefined) {
													void runControl("set-model", () => onSetModel(candidate.model));
												}
											}}
										>
											{controls.models.map(({model, name}) => (
												<option
													key={`${model.provider}/${model.id}`}
													value={`${model.provider}/${model.id}`}
												>
													{name}
												</option>
											))}
										</select>
									</label>
								) : null}
								{controls.setThinking &&
								thinkingLevels.length > 0 &&
								onSetThinking !== undefined ? (
									<label>
										<span>Düşünme düzeyi</span>
										<select
											aria-label="Düşünme düzeyi"
											value={session.thinkingLevel}
											disabled={pendingControl !== null}
											onChange={(event) =>
												void runControl("set-thinking", () =>
													onSetThinking(event.currentTarget.value as ThinkingLevel),
												)
											}
										>
											{thinkingLevels.map((level) => (
												<option key={level} value={level}>
													{level}
												</option>
											))}
										</select>
									</label>
								) : null}
							</div>
							<div className="session-controls__actions">
								{controls.steer && onSteer !== undefined ? (
									<Button
										type="button"
										variant="secondary"
										disabled={pendingControl !== null || composerText().length === 0}
										onClick={() => {
											const text = composerText();
											if (text.length === 0) return;
											void runControl("steer", () => onSteer(text)).then((outcome) => {
												if (outcome?._tag !== "acknowledged") return;
												composer?.setContent("");
												requestAnimationFrame(() => composer?.editor.commands.focus("end"));
											});
										}}
									>
										{pendingControl === "steer" ? "Yönlendiriliyor" : "Yönlendir"}
									</Button>
								) : null}
								{controls.abort && onAbort !== undefined ? (
									<Button
										type="button"
										variant="danger"
										disabled={pendingControl !== null}
										onClick={() => void runControl("abort", onAbort)}
									>
										{pendingControl === "abort" ? "Durduruluyor" : "Durdur"}
									</Button>
								) : null}
							</div>
							{controlStatus === null ? null : (
								<p
									className="control-status"
									data-tone={
										controlStatus.danger ? "danger" : pendingControl === null ? "ready" : "loading"
									}
									role={controlStatus.danger ? "alert" : "status"}
									aria-live={controlStatus.danger ? "assertive" : "polite"}
								>
									{controlStatus.text}
								</p>
							)}
						</section>
					)}
					<section className="transcript nowheel nodrag nopan" aria-label="Oturum konuşması">
						{session.transcript.length === 0 ? (
							<EmptyState
								className="chat-empty"
								title="Henüz ileti yok"
								description="İlk istemi gönderdiğinde konuşma burada başlayacak."
							/>
						) : (
							session.transcript.map((entry) => <TranscriptEntry key={entry.id} entry={entry} />)
						)}
						<div ref={transcriptEnd} />
					</section>
				</>
			)}

			<form
				className="composer-shell nodrag nopan nowheel"
				onSubmit={submit}
				onKeyDown={handleComposerKeyDown}
			>
				<span className="composer-label">İstem</span>
				<Composer composer={composer} className="tuval-composer" />
				<p className="composer-hint">Göndermek için Enter, yeni satır için Shift + Enter.</p>
				{sendStatus === null ? null : (
					<p
						className="send-status"
						data-tone={sendStatus.tone}
						role={sendStatus.tone === "danger" ? "alert" : "status"}
					>
						{sendStatus.text}
					</p>
				)}
				<Button variant="primary" type="submit" disabled={!canSend} loading={sending}>
					{sending ? "Gönderiliyor" : "Gönder"}
				</Button>
			</form>
		</Surface>
	);
}
