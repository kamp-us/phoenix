import {Composer, useComposerEditor} from "@kampus/composer";
import type {FormEvent, KeyboardEvent, ReactNode} from "react";
import {useEffect, useRef, useState} from "react";
import type {DiscoveredSession} from "../shared/discovery.js";
import type {
	LiveSessionView,
	LiveTranscriptEntry,
	TranscriptContent,
} from "../shared/live-session.js";
import {sessionTitle} from "./canvas-adapter.js";

export type PaneConnection = "pending" | "attached" | "refused" | "disconnected" | "malformed";

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
	readonly onSend: (text: string) => Promise<SendResult>;
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
	<article
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
	</article>
);

const connectionCopy = (
	connection: PaneConnection,
	message: string | undefined,
): {readonly tone: string; readonly title: string; readonly detail: string} => {
	if (connection === "pending") {
		return {tone: "loading", title: "Bağlanıyor", detail: "Oturum sahipliği doğrulanıyor."};
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

export function ChatPane({selected, connection, session, message, onClose, onSend}: ChatPaneProps) {
	const [sending, setSending] = useState(false);
	const [sendStatus, setSendStatus] = useState<{
		readonly tone: string;
		readonly text: string;
	} | null>(null);
	const transcriptEnd = useRef<HTMLDivElement>(null);
	const composer = useComposerEditor();
	const connectionStatus = connectionCopy(connection, message);
	const canSend = connection === "attached" && session?._tag === "attached" && !sending;

	useEffect(() => {
		setSending(false);
		setSendStatus(null);
	}, [selected.identity]);

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
		const text = composer?.getMarkdown().trim() ?? "";
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
		<aside className="chat-pane" aria-labelledby="chat-title" data-connection={connection}>
			<header className="chat-pane__header">
				<div>
					<p className="chat-pane__eyebrow">Canlı oturum</p>
					<h2 id="chat-title">{sessionTitle(selected.cwd)}</h2>
					<p className="chat-pane__path">{selected.cwd}</p>
				</div>
				<button className="control-button" type="button" onClick={onClose}>
					Sohbeti kapat
				</button>
			</header>

			<div
				className="chat-connection"
				data-tone={connectionStatus.tone}
				role={connectionStatus.tone === "danger" ? "alert" : "status"}
				aria-live={connectionStatus.tone === "danger" ? "assertive" : "polite"}
			>
				<strong>{connectionStatus.title}</strong>
				<span>{connectionStatus.detail}</span>
			</div>

			{session === null ? (
				<div className="chat-empty" role="status">
					<strong>Konuşma bekleniyor</strong>
					<span>Bağlantı doğrulanınca mevcut konuşma burada açılacak.</span>
				</div>
			) : (
				<>
					<div className="session-phase" data-completion={session.completion}>
						<strong>{completionLabel[session.completion]}</strong>
						<span>{phaseLabel[session.phase]}</span>
						<span>
							{session.model.provider} · {session.model.id} · {session.thinkingLevel}
						</span>
					</div>
					<section className="transcript nowheel nodrag nopan" aria-label="Oturum konuşması">
						{session.transcript.length === 0 ? (
							<div className="chat-empty">
								<strong>Henüz ileti yok</strong>
								<span>İlk istemi gönderdiğinde konuşma burada başlayacak.</span>
							</div>
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
				<button
					className="control-button control-button--primary"
					type="submit"
					disabled={!canSend}
				>
					{sending ? "Gönderiliyor" : "Gönder"}
				</button>
			</form>
		</aside>
	);
}
