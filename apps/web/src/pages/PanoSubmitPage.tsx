import {Alert, Button, DraftRestoreBanner, Input, Textarea, ToggleGroup} from "@kampus/design";
import {ArrowLeft} from "lucide-react";
import * as React from "react";
import {useFateClient} from "react-fate";
import {Link, useNavigate} from "react-router";
import {useSession} from "../auth/client";
import {FirstContributionOnramp} from "../components/authorship/FirstContributionOnramp";
import {Icon} from "../components/Icon";
import {actorLabel} from "../components/moderation/actor-identity";
import {PanoPostCardView} from "../components/pano/PanoPostCard";
import {useDraftSubmit} from "../fate/useDraftSubmit";
import type {WireMessageOverrides} from "../fate/wireMessages";
import {panoSubmitGate} from "../lib/panoSubmitGate";
import {POST_TAG_KINDS, tagClass, tagLabel} from "../lib/panoTags";
import {authRedirectPath} from "../lib/returnTo";
import {useDraftAutosave} from "../lib/useDraftAutosave";
import {prefillIfEmpty, useLinkMetadata} from "../lib/useLinkMetadata";
import {postSubmitMembership} from "./panoSubmitArgs";
import "./PanoSubmitPage.css";

type Mode = "link" | "text";

const PANO_SUBMIT_ROUTE = "/pano/yeni";

// The client-side autosave draft (localStorage), not the server-side `saveDraft`.
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

// Sourced from the same module the server allow-list imports, so the form can't drift.
const TAGS = POST_TAG_KINDS.map((kind) => ({kind, label: tagLabel(kind), cls: tagClass(kind)}));

const URL_RE = /^https?:\/\/[^/]+/i;

function hostOf(url: string) {
	const m = URL_RE.exec(url);
	return m ? m[0].replace(/^https?:\/\//, "") : "";
}

const TITLE_MAX = 200;
const BODY_MAX = 10_000;
const TITLE_MIN = 5;

const PANO_SUBMIT_OVERRIDES: WireMessageOverrides = {
	TITLE_REQUIRED: "başlık boş olamaz",
	TITLE_TOO_LONG: `başlık en fazla ${TITLE_MAX} karakter olabilir`,
	BODY_TOO_LONG: `metin en fazla ${BODY_MAX} karakter olabilir`,
	TAGS_REQUIRED: "en az bir etiket seç",
	TAG_INVALID: "geçersiz etiket",
	URL_INVALID: "geçersiz bağlantı",
	TOO_SHORT: `başlık en az ${TITLE_MIN} karakter olmalı`,
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
	const {fetchMetadata} = useLinkMetadata();
	const {
		error,
		setError,
		inFlight: isInFlight,
		run,
	} = useDraftSubmit({overrides: PANO_SUBMIT_OVERRIDES, redirectPath: () => "/pano/yeni"});

	async function prefillFromUrl() {
		const meta = await fetchMetadata(url);
		prefillIfEmpty(title, meta.title, setTitle);
		prefillIfEmpty(body, meta.description, setBody);
	}
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
				// The optimistic prepend and the `appendNode` push carry the same row; fate's
				// reconcile dedups by id, so the mutator's own client gets no double-row.
				// See `.patterns/fate-mutations-client.md`.
				fate.mutations.post.submit({
					input: {
						title: trimmedTitle,
						tags: Array.from(selectedTags).map((kind) => ({kind})),
						...(mode === "link" && trimmedUrl ? {url: trimmedUrl} : {}),
						...(body.trim() ? {body} : {}),
					},
					view: PanoPostCardView,
					...postSubmitMembership({
						title: trimmedTitle,
						url: linkUrl,
						host: linkUrl ? hostOf(linkUrl) : null,
						tags: Array.from(selectedTags),
						// Never fall back to `user.email` here — it would leak into the rendered
						// optimistic author (#2126).
						author: actorLabel(user.name, null, "kullanıcı"),
						authorId: user.id,
						now,
					}),
				}),
			"gönderi paylaşılamadı",
			(result) => {
				draft.clear();
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
						<Icon icon={ArrowLeft} size={14} />
						akışa dön
					</Link>
					<h1 className="kp-pano-submit__title">bir şey paylaş</h1>
					<p className="kp-pano-submit__lede">
						bağlantı, yazı, soru. self-promo da olur — bir kere açıkla niye paylaşıyorsun.
					</p>

					<ToggleGroup
						className="kp-toggle-group kp-toggle-group--segmented kp-pano-submit__toggle"
						size="sm"
						items={[
							{value: "link", label: "link"},
							{value: "text", label: "yazı"},
						]}
						value={[mode]}
						onValueChange={([next]) => {
							if (next) setMode(next as Mode);
						}}
					/>

					{draft.offered ? (
						<DraftRestoreBanner onRestore={restoreDraft} onDismiss={draft.dismiss} />
					) : null}

					<FirstContributionOnramp surface="pano" />

					<form className="kp-pano-submit__form" onSubmit={onSubmit}>
						{mode === "link" ? (
							<>
								<Input
									className="kp-pano-submit__field"
									id="submit-url"
									data-testid="pano-submit-url"
									type="url"
									label="URL"
									placeholder="https://overreacted.io/..."
									value={url}
									onChange={(e) => setUrl(e.currentTarget.value)}
									onBlur={prefillFromUrl}
									fullWidth
								/>
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

						<Input
							className="kp-pano-submit__field"
							id="submit-title"
							data-testid="pano-submit-title"
							type="text"
							label="başlık"
							hint={
								<>
									{titleTooShort ? "5 karakterden az olamaz · " : ""}
									{titleTooLong ? `en fazla ${TITLE_MAX} karakter · ` : ""}
									{title.length}/{TITLE_MAX}
								</>
							}
							minLength={TITLE_MIN}
							maxLength={TITLE_MAX + 50}
							placeholder="en az 5 karakter"
							value={title}
							onChange={(e) => setTitle(e.currentTarget.value)}
							fullWidth
						/>

						{mode === "link" ? (
							<Textarea
								className="kp-pano-submit__field"
								id="submit-context"
								data-testid="pano-submit-body"
								label="bağlam (opsiyonel)"
								placeholder="bir kere açıkla niye paylaşıyorsun"
								value={body}
								onChange={(e) => setBody(e.currentTarget.value)}
								fullWidth
								resize="vertical"
							/>
						) : (
							<Textarea
								className="kp-pano-submit__field kp-pano-submit__field--body"
								id="submit-body"
								data-testid="pano-submit-body"
								label={
									<>
										içerik{" "}
										<span style={{color: "var(--text-faint)", fontWeight: 400}}>(opsiyonel)</span>
									</>
								}
								hint={
									<>
										markdown · ``` ``` kod bloğu · {body.length}/{BODY_MAX}
									</>
								}
								placeholder="markdown · ``` ``` kod bloğu"
								value={body}
								onChange={(e) => setBody(e.currentTarget.value)}
								fullWidth
								resize="vertical"
							/>
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
							<ToggleGroup
								className="kp-toggle-group kp-pano-submit__tagrow"
								size="sm"
								multiple
								value={Array.from(selectedTags)}
								onValueChange={(next) => {
									if (next.length <= 3) setSelectedTags(new Set(next));
								}}
								items={TAGS.map((tag) => ({
									value: tag.kind,
									label: (
										<span
											className={`kp-pano-submit__tag-label kp-tag--${tag.cls}`}
											data-testid={`pano-submit-tag-${tag.cls}`}
										>
											{tag.label}
										</span>
									),
								}))}
							/>
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
							<Alert
								variant="danger"
								className="kp-alert--inline kp-pano-submit__hint"
								data-testid="pano-submit-error"
								style={{color: "var(--danger)"}}
							>
								{error}
							</Alert>
						) : null}

						{draftSaved ? (
							<Alert
								variant="success"
								className="kp-alert--inline kp-pano-submit__hint"
								data-testid="pano-submit-draft-saved"
								style={{color: "var(--text-faint)"}}
							>
								taslak kaydedildi
							</Alert>
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
							<Button
								type="button"
								variant="tertiary"
								data-testid="pano-submit-draft"
								disabled={isInFlight}
								onClick={onSaveDraft}
							>
								taslak
							</Button>
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
