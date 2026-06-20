import * as React from "react";
import {useFateClient} from "react-fate";
import {Link, useNavigate} from "react-router";
import {useSession} from "../auth/client";
import {PanoPostCardView} from "../components/pano/PanoPostCard";
import {Button} from "../components/ui/Button";
import {codeOf} from "../fate/wire";
import {FlagGate} from "../flags/FlagGate";
import {PANO_DRAFT_SAVE} from "../flags/keys";
import type {FateWireCode} from "../lib/fateWireCodes";
import {authRedirectPath} from "../lib/returnTo";
import "./PanoSubmitPage.css";

type Mode = "link" | "text";

/**
 * Fixed tag enum — kinds match the producer-side `ALLOWED_POST_TAG_KINDS` and are
 * stored verbatim on `post_summary.tags`. `cls` is a CSS modifier chosen to match
 * the existing Tag styling without touching the server-side kind enum.
 */
const TAGS: {kind: string; label: string; cls: string}[] = [
	{kind: "göster", label: "göster", cls: "show"},
	{kind: "tartışma", label: "tartışma", cls: "discuss"},
	{kind: "soru", label: "soru", cls: "ask"},
	{kind: "söylenme", label: "söylenme", cls: "rant"},
	{kind: "meta", label: "meta", cls: "meta"},
];

const URL_RE = /^https?:\/\/[^/]+/i;

function hostOf(url: string) {
	const m = URL_RE.exec(url);
	return m ? m[0].replace(/^https?:\/\//, "") : "";
}

const TITLE_MAX = 200;
const BODY_MAX = 10_000;
const TITLE_MIN = 5;

/** Turkish copy for the validation codes the submit form surfaces inline. */
const messageForCode = (code: FateWireCode, fallback: string): string => {
	switch (code) {
		case "TITLE_REQUIRED":
			return "başlık boş olamaz";
		case "TITLE_TOO_LONG":
			return `başlık en fazla ${TITLE_MAX} karakter olabilir`;
		case "BODY_TOO_LONG":
			return `metin en fazla ${BODY_MAX} karakter olabilir`;
		case "TAGS_REQUIRED":
			return "en az bir etiket seç";
		case "TAG_INVALID":
			return "geçersiz etiket";
		case "URL_INVALID":
			return "geçersiz bağlantı";
		case "TOO_SHORT":
			return `başlık en az ${TITLE_MIN} karakter olmalı`;
		default:
			return fallback;
	}
};

export function PanoSubmitPage() {
	const session = useSession();
	const navigate = useNavigate();
	const [mode, setMode] = React.useState<Mode>("link");
	const [url, setUrl] = React.useState("");
	const [title, setTitle] = React.useState("");
	const [body, setBody] = React.useState("");
	const [selectedTags, setSelectedTags] = React.useState<Set<string>>(new Set());
	const [error, setError] = React.useState<string | null>(null);
	const [draftSaved, setDraftSaved] = React.useState(false);

	const fate = useFateClient();
	const [isInFlight, setInFlight] = React.useState(false);

	const host = hostOf(url);
	const showPreview = mode === "link" && host.length > 0;

	function toggleTag(kind: string) {
		setSelectedTags((prev) => {
			const next = new Set(prev);
			if (next.has(kind)) next.delete(kind);
			else if (next.size < 3) next.add(kind);
			return next;
		});
	}

	const trimmedTitle = title.trim();
	const titleTooShort = trimmedTitle.length > 0 && trimmedTitle.length < TITLE_MIN;
	const titleTooLong = trimmedTitle.length > TITLE_MAX;
	const bodyTooLong = body.length > BODY_MAX;
	const noTags = selectedTags.size === 0;
	const linkModeUrlEmpty = mode === "link" && url.trim().length === 0;

	const submitDisabled =
		isInFlight ||
		trimmedTitle.length < TITLE_MIN ||
		titleTooLong ||
		bodyTooLong ||
		noTags ||
		linkModeUrlEmpty;

	async function onSubmit(e: React.SyntheticEvent) {
		e.preventDefault();
		setError(null);

		if (!session.data?.user) {
			navigate(authRedirectPath("/pano/yeni"));
			return;
		}
		if (submitDisabled) return;

		const trimmedUrl = url.trim();
		const user = session.data.user;
		const now = new Date();
		setInFlight(true);
		try {
			// `insert: "before"` declaratively prepends the new post into the
			// registered no-filter feed root list — NO imperative connection-key
			// updater. The optimistic temp record (temp id fate reconciles to the
			// server id) makes the prepend show during the in-flight window.
			const {result, error: callError} = await fate.mutations.post.submit({
				input: {
					title: trimmedTitle,
					tags: Array.from(selectedTags).map((kind) => ({kind})),
					...(mode === "link" && trimmedUrl ? {url: trimmedUrl} : {}),
					...(body.trim() ? {body} : {}),
				},
				view: PanoPostCardView,
				insert: "before",
				optimistic: {
					id: `optimistic:${Date.now()}`,
					slug: null,
					title: trimmedTitle,
					url: mode === "link" && trimmedUrl ? trimmedUrl : null,
					host: mode === "link" && trimmedUrl ? hostOf(trimmedUrl) : null,
					author: user.name ?? user.email,
					authorId: user.id,
					// Submitting a post is NOT a self-upvote: the server inserts it at
					// score 0 with no viewer vote (Pano.submitPost). The optimistic record
					// must mirror that, else its score:1/myVote:1 reconciles onto the
					// server-id'd Post and bleeds a phantom self-upvote into the
					// freshly-navigated detail page (#707).
					score: 0,
					myVote: null,
					commentCount: 0,
					createdAt: now,
					tags: Array.from(selectedTags).map((kind) => ({kind, label: kind})),
				},
			});
			if (callError) {
				setError(messageForCode(codeOf(callError), callError.message));
				return;
			}
			const newId = result?.slug ?? result?.id;
			if (newId) navigate(`/pano/${newId}`);
		} catch (caught) {
			const code = codeOf(caught);
			if (code === "UNAUTHORIZED") {
				navigate(authRedirectPath("/pano/yeni"));
				return;
			}
			setError(messageForCode(code, "gönderi paylaşılamadı"));
		} finally {
			setInFlight(false);
		}
	}

	async function onSaveDraft() {
		setError(null);
		setDraftSaved(false);
		if (!session.data?.user) {
			navigate(authRedirectPath("/pano/yeni"));
			return;
		}
		const trimmedUrl = url.trim();
		setInFlight(true);
		try {
			const {error: callError} = await fate.mutations.post.saveDraft({
				input: {
					title: trimmedTitle,
					...(mode === "link" && trimmedUrl ? {url: trimmedUrl} : {}),
					...(body.trim() ? {body} : {}),
					tags: Array.from(selectedTags).map((kind) => ({kind})),
				},
				view: PanoPostCardView,
			});
			if (callError) {
				setError(messageForCode(codeOf(callError), callError.message));
				return;
			}
			setDraftSaved(true);
		} catch (caught) {
			const code = codeOf(caught);
			if (code === "UNAUTHORIZED") {
				navigate(authRedirectPath("/pano/yeni"));
				return;
			}
			setError(messageForCode(code, "taslak kaydedilemedi"));
		} finally {
			setInFlight(false);
		}
	}

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<div className="kp-pano-submit">
					<Link to="/pano" className="kp-pano-submit__back">
						← akışa dön
					</Link>
					<h1 className="kp-pano-submit__title">Bir şey paylaş</h1>
					<p className="kp-pano-submit__lede">
						Bağlantı, yazı, soru. Self-promo da olur — bir kere açıkla niye paylaşıyorsun.
					</p>

					<div className="kp-pano-submit__toggle">
						<button type="button" aria-pressed={mode === "link"} onClick={() => setMode("link")}>
							link
						</button>
						<button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")}>
							yazı
						</button>
					</div>

					<form className="kp-pano-submit__form" onSubmit={onSubmit}>
						{mode === "link" ? (
							<>
								<div className="kp-pano-submit__field">
									<label htmlFor="submit-url">URL</label>
									<input
										id="submit-url"
										data-testid="pano-submit-url"
										type="url"
										placeholder="https://overreacted.io/..."
										value={url}
										onChange={(e) => setUrl(e.currentTarget.value)}
									/>
								</div>
								{showPreview ? (
									<div className="kp-pano-submit__url-preview">
										<div className="fav">{host.charAt(0).toLowerCase()}</div>
										<div>
											<div className="host">{host}</div>
											<div className="ttl">{title || "başlık otomatik tamamlanacak"}</div>
										</div>
									</div>
								) : null}
							</>
						) : null}

						<div className="kp-pano-submit__field">
							<label htmlFor="submit-title">başlık</label>
							<input
								id="submit-title"
								data-testid="pano-submit-title"
								type="text"
								minLength={TITLE_MIN}
								maxLength={TITLE_MAX + 50}
								placeholder="en az 5 karakter"
								value={title}
								onChange={(e) => setTitle(e.currentTarget.value)}
							/>
							<span className="kp-pano-submit__hint">
								{titleTooShort ? "5 karakterden az olamaz · " : ""}
								{titleTooLong ? `en fazla ${TITLE_MAX} karakter · ` : ""}
								{title.length}/{TITLE_MAX}
							</span>
						</div>

						{mode === "link" ? (
							<div className="kp-pano-submit__field">
								<label htmlFor="submit-context">bağlam (opsiyonel)</label>
								<textarea
									id="submit-context"
									data-testid="pano-submit-body"
									placeholder="bir kere açıkla niye paylaşıyorsun"
									value={body}
									onChange={(e) => setBody(e.currentTarget.value)}
								/>
							</div>
						) : (
							<div className="kp-pano-submit__field">
								<label htmlFor="submit-body">
									içerik{" "}
									<span style={{color: "var(--text-faint)", fontWeight: 400}}>(opsiyonel)</span>
								</label>
								<textarea
									id="submit-body"
									data-testid="pano-submit-body"
									style={{minHeight: 220}}
									placeholder="markdown · ``` ``` kod bloğu"
									value={body}
									onChange={(e) => setBody(e.currentTarget.value)}
								/>
								<span className="kp-pano-submit__hint">
									markdown · ``` ``` kod bloğu · {body.length}/{BODY_MAX}
								</span>
							</div>
						)}

						<fieldset className="kp-pano-submit__field kp-pano-submit__fieldset">
							<legend className="kp-pano-submit__field-label">etiketler · en fazla 3</legend>
							<div className="kp-pano-submit__tagrow">
								{TAGS.map((t) => {
									const on = selectedTags.has(t.kind);
									return (
										<button
											key={t.kind}
											type="button"
											data-testid={`pano-submit-tag-${t.cls}`}
											className={`kp-tag kp-tag--${t.cls} ${on ? "is-on" : ""}`}
											aria-pressed={on}
											onClick={() => toggleTag(t.kind)}
										>
											{t.label}
										</button>
									);
								})}
							</div>
						</fieldset>

						{error ? (
							<p
								className="kp-pano-submit__hint"
								role="alert"
								data-testid="pano-submit-error"
								style={{color: "var(--danger)"}}
							>
								{error}
							</p>
						) : null}

						{draftSaved ? (
							<p
								className="kp-pano-submit__hint"
								role="status"
								data-testid="pano-submit-draft-saved"
								style={{color: "var(--text-faint)"}}
							>
								taslak kaydedildi
							</p>
						) : null}

						<div className="kp-pano-submit__form-actions">
							<FlagGate flag={PANO_DRAFT_SAVE}>
								<Button
									type="button"
									variant="tertiary"
									data-testid="pano-submit-draft"
									disabled={isInFlight}
									onClick={onSaveDraft}
								>
									taslak
								</Button>
							</FlagGate>
							<Button
								type="submit"
								variant="primary"
								disabled={submitDisabled}
								data-testid="pano-submit-submit"
							>
								{isInFlight ? "gönderiliyor…" : "paylaş"}
							</Button>
						</div>
					</form>
				</div>
			</div>
		</div>
	);
}
