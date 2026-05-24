import * as React from "react";
import {useFateClient} from "react-fate";
import {Link, useNavigate} from "react-router";
import {useSession} from "../auth/client";
import {PanoPostCardView} from "../components/pano/PanoPostCard";
import {Button} from "../components/ui/Button";
import {decodeMutationErrorCode, type MutationErrorCode} from "../lib/mutationErrorCodes";
import {authRedirectPath} from "../lib/returnTo";
import "./PanoSubmitPage.css";

type Mode = "link" | "text";

/**
 * Fixed tag enum — kind values match the producer-side `ALLOWED_POST_TAG_KINDS`
 * in `PanoPost`. The Turkish kinds (`göster`, `tartışma`, …) are stored
 * verbatim on `post_summary.tags`; the `cls` value is a CSS modifier picked
 * to match the existing Tag styling without touching the kind enum on the
 * server.
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

/** Read the `.code` off a thrown / returned fate error. */
const codeOf = (error: unknown): MutationErrorCode =>
	error && typeof error === "object" && "code" in error
		? (decodeMutationErrorCode((error as {code: unknown}).code) ?? "INTERNAL_SERVER_ERROR")
		: "INTERNAL_SERVER_ERROR";

const TITLE_MAX = 200;
const BODY_MAX = 10_000;
const TITLE_MIN = 5;

/** Turkish copy for the validation codes the submit form surfaces inline. */
const messageForCode = (code: MutationErrorCode, fallback: string): string => {
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

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);

		if (!session.data?.user) {
			navigate(authRedirectPath("/pano/yeni"));
			return;
		}
		if (submitDisabled) return;

		// Pre-trim/normalize so the server never sees unintended whitespace on the
		// title; resolver-side validation surfaces typed `code`s back.
		const trimmedUrl = url.trim();
		const user = session.data.user;
		const now = new Date();
		setInFlight(true);
		try {
			// Declarative connection membership: `insert: "before"` prepends the new
			// post into the registered no-filter feed root list — fate writes the
			// returned `Post` (shaped by `PanoPostCardView`) into the normalized cache
			// and joins it to the front of the `posts` connection. NO imperative
			// connection-key updater.
			// The optimistic temp record (with a temp id fate reconciles to the server
			// id) makes the prepend show instantly during the in-flight window.
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
					score: 1,
					myVote: 1,
					commentCount: 0,
					createdAt: now,
					tags: Array.from(selectedTags).map((kind) => ({kind, label: kind})),
				},
			});
			if (callError) {
				setError(messageForCode(codeOf(callError), callError.message));
				return;
			}
			// The /pano/:id route key is the raw post id (or slug). fate ids are raw.
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

						<div className="kp-pano-submit__form-actions">
							<Button type="button" variant="tertiary">
								taslak
							</Button>
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
