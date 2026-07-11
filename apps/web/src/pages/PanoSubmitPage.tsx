import * as React from "react";
import {useFateClient} from "react-fate";
import {Link, useNavigate} from "react-router";
import {useSession} from "../auth/client";
import {FirstContributionOnramp} from "../components/authorship/FirstContributionOnramp";
import {actorLabel} from "../components/moderation/actor-identity";
import {PanoPostCardView} from "../components/pano/PanoPostCard";
import {Button} from "../components/ui/Button";
import {DraftRestoreBanner} from "../components/ui/DraftRestoreBanner";
import {useDraftSubmit} from "../fate/useDraftSubmit";
import type {WireMessageOverrides} from "../fate/wireMessages";
import {FlagGate} from "../flags/FlagGate";
import {PANO_DRAFT_SAVE, PANO_OPTIMISTIC_SUBMIT} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {panoSubmitGate} from "../lib/panoSubmitGate";
import {POST_TAG_KINDS, tagClass, tagLabel} from "../lib/panoTags";
import {authRedirectPath} from "../lib/returnTo";
import {useDraftAutosave} from "../lib/useDraftAutosave";
import {prefillIfEmpty, useLinkMetadata} from "../lib/useLinkMetadata";
import {postSubmitMembership} from "./panoSubmitArgs";
import "./PanoSubmitPage.css";

type Mode = "link" | "text";

/** The submit route — keys the autosaved draft, matching the auth `returnTo` below (#1214). */
const PANO_SUBMIT_ROUTE = "/pano/yeni";

/** The client-side autosave draft for the pano submit form (localStorage, not the server `saveDraft`). */
interface PanoDraft {
	mode: Mode;
	url: string;
	title: string;
	body: string;
	tags: string[];
}

function isPanoDraft(value: unknown): value is PanoDraft {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		(v.mode === "link" || v.mode === "text") &&
		typeof v.url === "string" &&
		typeof v.title === "string" &&
		typeof v.body === "string" &&
		Array.isArray(v.tags) &&
		v.tags.every((t) => typeof t === "string")
	);
}

const isPanoDraftEmpty = (d: PanoDraft): boolean =>
	d.url.trim() === "" && d.title.trim() === "" && d.body.trim() === "" && d.tags.length === 0;

// The five kinds + their CSS modifier (`cls`) come from the shared typed home
// `src/lib/panoTags.ts` (#1030) — the same module the server allow-list imports,
// so the form can't drift from the producer enum.
const TAGS = POST_TAG_KINDS.map((kind) => ({kind, label: tagLabel(kind), cls: tagClass(kind)}));

const URL_RE = /^https?:\/\/[^/]+/i;

function hostOf(url: string) {
	const m = URL_RE.exec(url);
	return m ? m[0].replace(/^https?:\/\//, "") : "";
}

const TITLE_MAX = 200;
const BODY_MAX = 10_000;
const TITLE_MIN = 5;

/** Submit-form copy that overrides the shared {@link WIRE_MESSAGES} base. */
const PANO_SUBMIT_OVERRIDES: WireMessageOverrides = {
	TITLE_REQUIRED: "başlık boş olamaz",
	TITLE_TOO_LONG: `başlık en fazla ${TITLE_MAX} karakter olabilir`,
	BODY_TOO_LONG: `metin en fazla ${BODY_MAX} karakter olabilir`,
	TAGS_REQUIRED: "en az bir etiket seç",
	TAG_INVALID: "geçersiz etiket",
	URL_INVALID: "geçersiz bağlantı",
	TOO_SHORT: `başlık en az ${TITLE_MIN} karakter olmalı`,
	DRAFTS_DISABLED: "taslaklar şu an devre dışı",
	VALIDATION_ERROR: "girdiğin bilgiler geçersiz",
	USER_NOT_FOUND: "kullanıcı bulunamadı",
	BAD_REQUEST: "geçersiz istek",
};

export function PanoSubmitPage() {
	const session = useSession();
	const navigate = useNavigate();
	const [mode, setMode] = React.useState<Mode>("link");
	const [url, setUrl] = React.useState("");
	const [title, setTitle] = React.useState("");
	const [body, setBody] = React.useState("");
	const [selectedTags, setSelectedTags] = React.useState<Set<string>>(new Set());
	const [draftSaved, setDraftSaved] = React.useState(false);

	const fate = useFateClient();
	// Default-off containment flag (#1676, epic #1637): off ⇒ plain round-trip;
	// on ⇒ optimistic front-of-feed insert that reconciles to the server row.
	const {value: optimisticSubmit} = useFlag(PANO_OPTIMISTIC_SUBMIT, false);
	const {fetchMetadata} = useLinkMetadata();
	const {
		error,
		setError,
		inFlight: isInFlight,
		run,
	} = useDraftSubmit({overrides: PANO_SUBMIT_OVERRIDES, redirectPath: () => "/pano/yeni"});

	// Prefill the (still-empty) title/context from the pasted link's metadata on
	// URL blur — the shared policy in `prefillIfEmpty` never clobbers user input.
	async function prefillFromUrl() {
		const meta = await fetchMetadata(url);
		prefillIfEmpty(title, meta.title, setTitle);
		prefillIfEmpty(body, meta.description, setBody);
	}
	const urlRef = React.useRef<HTMLInputElement>(null);
	const titleRef = React.useRef<HTMLInputElement>(null);

	const draftValue = React.useMemo<PanoDraft>(
		() => ({mode, url, title, body, tags: Array.from(selectedTags)}),
		[mode, url, title, body, selectedTags],
	);
	const draft = useDraftAutosave({
		route: PANO_SUBMIT_ROUTE,
		value: draftValue,
		isEmpty: isPanoDraftEmpty,
		isValid: isPanoDraft,
	});

	function restoreDraft() {
		const d = draft.offered;
		if (!d) return;
		setMode(d.mode);
		setUrl(d.url);
		setTitle(d.title);
		setBody(d.body);
		setSelectedTags(new Set(d.tags));
		draft.accept();
	}

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

	const {submitDisabled, tagsAreSoleBlocker} = panoSubmitGate({
		inFlight: isInFlight,
		titleInvalid: trimmedTitle.length < TITLE_MIN,
		titleTooLong,
		bodyTooLong,
		noTags,
		linkModeUrlEmpty,
	});

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
		const linkUrl = mode === "link" && trimmedUrl ? trimmedUrl : null;
		await run(
			() =>
				// The pano feed is a registered no-filter root list, so under the
				// containment flag `insert: "before"` declaratively prepends the new
				// post with a temp-id optimistic node fate reconciles to the server id
				// (the same row `live.post.feed.appendNode` carries — reconcile dedups by
				// id, so no double-row for the mutator's own client). Flag off ⇒ plain
				// round-trip. See `.patterns/fate-mutations-client.md`.
				fate.mutations.post.submit({
					input: {
						title: trimmedTitle,
						tags: Array.from(selectedTags).map((kind) => ({kind})),
						...(mode === "link" && trimmedUrl ? {url: trimmedUrl} : {}),
						...(body.trim() ? {body} : {}),
					},
					view: PanoPostCardView,
					...postSubmitMembership(optimisticSubmit, {
						title: trimmedTitle,
						url: linkUrl,
						host: linkUrl ? hostOf(linkUrl) : null,
						tags: Array.from(selectedTags),
						// Shared actor-label rule (#2126): display name → fixed noun, never the
						// email the old `?? user.email` could leak into the optimistic author.
						// The session user has no typed `username`; the server round-trip
						// replaces this optimistic author with the stored value.
						author: actorLabel(user.name, null, "kullanıcı"),
						authorId: user.id,
						now,
					}),
				}),
			"gönderi paylaşılamadı",
			(result) => {
				draft.clear(); // submitted successfully — the autosaved draft is spent
				const newId = result?.slug ?? result?.id;
				if (newId) navigate(`/pano/${newId}`);
			},
		);
	}

	async function onSaveDraft() {
		setError(null);
		setDraftSaved(false);
		if (!session.data?.user) {
			navigate(authRedirectPath("/pano/yeni"));
			return;
		}
		const trimmedUrl = url.trim();
		await run(
			() =>
				fate.mutations.post.saveDraft({
					input: {
						title: trimmedTitle,
						...(mode === "link" && trimmedUrl ? {url: trimmedUrl} : {}),
						...(body.trim() ? {body} : {}),
						tags: Array.from(selectedTags).map((kind) => ({kind})),
					},
					view: PanoPostCardView,
				}),
			"taslak kaydedilemedi",
			() => setDraftSaved(true),
		);
	}

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<div className="kp-pano-submit">
					<Link to="/pano" className="kp-pano-submit__back">
						← akışa dön
					</Link>
					<h1 className="kp-pano-submit__title">bir şey paylaş</h1>
					<p className="kp-pano-submit__lede">
						bağlantı, yazı, soru. self-promo da olur — bir kere açıkla niye paylaşıyorsun.
					</p>

					<div className="kp-pano-submit__toggle">
						<button type="button" aria-pressed={mode === "link"} onClick={() => setMode("link")}>
							link
						</button>
						<button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")}>
							yazı
						</button>
					</div>

					{draft.offered ? (
						<DraftRestoreBanner onRestore={restoreDraft} onDismiss={draft.dismiss} />
					) : null}

					<FirstContributionOnramp surface="pano" />

					<form className="kp-pano-submit__form" onSubmit={onSubmit}>
						{mode === "link" ? (
							<>
								<div className="kp-pano-submit__field">
									<label htmlFor="submit-url">URL</label>
									<input
										ref={urlRef}
										id="submit-url"
										data-testid="pano-submit-url"
										type="url"
										placeholder="https://overreacted.io/..."
										value={url}
										onChange={(e) => setUrl(e.currentTarget.value)}
										onBlur={prefillFromUrl}
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
								ref={titleRef}
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
							<legend className="kp-pano-submit__field-label">
								<span>etiketler · en az 1, en fazla 3</span>
								<span
									className="kp-pano-submit__required"
									data-testid="pano-submit-tags-legend-required"
								>
									gerekli
								</span>
							</legend>
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
							{/* The required-tag cue is the load-bearing affordance (#2575): it renders
							    whenever a tag is missing — NOT gated on tagsAreSoleBlocker — so a cold user
							    sees it before the rest of the form is perfect. tagsAreSoleBlocker only
							    upgrades the phrasing to "one step left" (#2201's sole-blocker signal). */}
							{noTags ? (
								<span className="kp-pano-submit__tag-cue" data-testid="pano-submit-tags-required">
									{tagsAreSoleBlocker
										? "son adım: en az bir etiket seç"
										: PANO_SUBMIT_OVERRIDES.TAGS_REQUIRED}
								</span>
							) : null}
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

						{submitDisabled && noTags ? (
							<p
								id="pano-submit-disabled-reason"
								className="kp-pano-submit__disabled-reason"
								data-testid="pano-submit-disabled-reason"
							>
								{tagsAreSoleBlocker
									? "“paylaş” için son bir adım kaldı: yukarıdan en az bir etiket seç"
									: "“paylaş” için en az bir etiket seçmelisin"}
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
								title={submitDisabled && noTags ? "en az bir etiket seç" : undefined}
								aria-describedby={
									submitDisabled && noTags ? "pano-submit-disabled-reason" : undefined
								}
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
