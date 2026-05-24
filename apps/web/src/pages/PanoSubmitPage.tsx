import * as React from "react";
import {graphql, useMutation} from "react-relay";
import {Link, useNavigate} from "react-router";
import type {PanoSubmitPageMutation} from "../__generated__/PanoSubmitPageMutation.graphql";
import {useSession} from "../auth/client";
import {Button} from "../components/ui/Button";
import {authRedirectPath} from "../lib/returnTo";
import {useSessionExpiredToast} from "../lib/useSessionExpiredToast";
import {extractLocalId} from "../relay/encodeNodeId";
import {prependPostToFeedConnections} from "../relay/panoFeedUpdater";
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

/**
 * `submitPost` mutation. The payload spreads
 * `PanoPostCardFragment` so the post lands in the Relay store with every
 * field a feed card needs — the manual `updater` (see `panoFeedUpdater.ts`)
 * then prepends a `PostEdge` referencing it into every active
 * `PanoFeed_posts` connection.
 */
const SubmitPostMutation = graphql`
  mutation PanoSubmitPageMutation(
    $title: String!
    $url: String
    $body: String
    $tags: [TagInput!]!
  ) {
    submitPost(title: $title, url: $url, body: $body, tags: $tags) {
      id
      slug
      title
      url
      host
      author
      authorId
      score
      myVote
      commentCount
      createdAt
      tags {
        kind
        label
      }
      ...PanoPostCardFragment
    }
  }
`;

const TITLE_MAX = 200;
const BODY_MAX = 10_000;
const TITLE_MIN = 5;

export function PanoSubmitPage() {
	const session = useSession();
	const navigate = useNavigate();
	const [mode, setMode] = React.useState<Mode>("link");
	const [url, setUrl] = React.useState("");
	const [title, setTitle] = React.useState("");
	const [body, setBody] = React.useState("");
	const [selectedTags, setSelectedTags] = React.useState<Set<string>>(new Set());
	const [error, setError] = React.useState<string | null>(null);

	const [commit, isInFlight] = useMutation<PanoSubmitPageMutation>(SubmitPostMutation);
	const {handleError: handleAuthError} = useSessionExpiredToast();

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

	function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);

		if (!session.data?.user) {
			navigate(authRedirectPath("/pano/yeni"));
			return;
		}
		if (submitDisabled) return;

		// Resolver-side validation surfaces typed errors back via `onError`/
		// `onCompleted(errors)` (see below); we still pre-trim/normalize here so
		// the server never sees unintended whitespace on the title.
		const variables: PanoSubmitPageMutation["variables"] = {
			title: trimmedTitle,
			tags: Array.from(selectedTags).map((kind) => ({kind})),
			...(mode === "link" && url.trim() ? {url: url.trim()} : {}),
			...(body.trim() ? {body} : {}),
		};

		// Optimistic temp record: prepended into every active `PanoFeed_posts`
		// connection during the in-flight window so a back-nav (or any other
		// surface still rendering the feed) sees the new post immediately.
		// The updater at `panoFeedUpdater.ts:68-69` short-circuits on a
		// head-node-id match, so when the server response lands with the
		// real Post.id, the temp edge is replaced cleanly (Relay rolls back
		// the optimistic update first, then re-applies the server updater).
		// Temp id uses a `temp-` prefix to be visually distinguishable in
		// devtools; it never escapes the store.
		const tempId = `temp-${Date.now()}`;
		const trimmedUrl = url.trim();
		commit({
			variables,
			optimisticResponse: {
				submitPost: {
					id: tempId,
					slug: null,
					title: trimmedTitle,
					url: mode === "link" && trimmedUrl ? trimmedUrl : null,
					host: mode === "link" && trimmedUrl ? hostOf(trimmedUrl) : null,
					author: session.data?.user?.name ?? "",
					authorId: session.data?.user?.id ?? "",
					score: 1,
					myVote: 1,
					commentCount: 0,
					createdAt: new Date().toISOString(),
					tags: Array.from(selectedTags).map((kind) => ({kind, label: kind})),
				},
			},
			// Hand-written updater: prepends a PostEdge into every active
			// `PanoFeed_posts` connection in the store, so the new post appears
			// at the top of the user's last-visited feed without a refetch
			// when they navigate back. Mirrors kampus's createStory updater.
			// Runs for both the optimistic pass (with `tempId`) and the real
			// server response (which replaces the temp edge in-place).
			updater: (store) => {
				prependPostToFeedConnections(store);
			},
			onCompleted: (data, errors) => {
				if (handleAuthError(errors)) return;
				if (errors && errors.length > 0) {
					setError(errors[0]?.message ?? "gönderi paylaşılamadı");
					return;
				}
				// `data.submitPost.id` is the Relay global id (`Post:<localId>`
				// base64). The /pano/:id route key is the local post id (or a
				// slug); extract before navigating so URLs stay clean and the
				// post-detail resolver hits the right per-post DO.
				const newId = data.submitPost.slug ?? extractLocalId(data.submitPost.id, "Post");
				if (newId) {
					navigate(`/pano/${newId}`);
				}
			},
			onError: (err) => {
				if (handleAuthError(null, err)) return;
				setError(err.message);
			},
		});
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
