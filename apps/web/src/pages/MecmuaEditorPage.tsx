/**
 * `/mecmua/yaz` — the mecmua authoring surface (#2499, epic #2467). The first
 * PRODUCT consumer of the shared headless `@kampus/composer` base (`/lab/composer`
 * was the first lab consumer): the composer owns the tiptap-wrapped editing
 * (StarterKit + `@tiptap/markdown`), this page owns only chrome + persistence,
 * wiring the composer's markdown output into `mecmua.saveDraft` / `mecmua.publish`.
 * Nothing here imports tiptap directly and no external editor lib is added.
 *
 * Two authority tiers (the ticket's load-bearing split):
 *   - taslak kaydet — any signed-in user may save a private draft (`mecmua.saveDraft`,
 *     normal-auth). Each save inserts a fresh draft row; multiple drafts per author
 *     are allowed by design (#2463), so there is no edit-in-place here (out of v1).
 *   - yayımla — offered ONLY to a yazar (`me.tier === "yazar"`), the trusted account
 *     tier read off the fate `me` view (never the untrusted session field). A çaylak /
 *     visitor sees the Turkish earned-gate message instead — publish is server-gated by
 *     `PublishMecmua` regardless, this is the honest UI mirror.
 *
 * Two routes reach this page (#2544): `/mecmua/yaz` opens a blank editor; `/mecmua/yaz/:id`
 * loads one of the author's OWN posts (via the `CurrentUser`-scoped `mecmuaMyPosts` read)
 * into the editor so a saved draft is reopenable. Multi-draft is unchanged — a save still
 * mints a fresh row (no edit-in-place), so `taslak kaydet` lands on the just-saved draft's
 * id rather than a blank editor. `taslaklarım` (`/mecmua/yazilarim`) lists them.
 *
 * The whole surface ships dark behind `MECMUA_WRITE` (default-off): the page
 * self-gates (off ⇒ 404), mirroring `MecmuaPostPage` / `DivanPage`, so the route is
 * absent until a human flips the flag at release (ADR 0083). Storage is the markdown
 * STRING the composer emits — no D1 schema change here.
 */
import {Composer, useComposerEditor} from "@kampus/composer";
import {useState} from "react";
import {useFateClient, useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {Link, useNavigate, useParams} from "react-router";
import type {MecmuaPost} from "../../worker/features/fate/views";
import {useSession} from "../auth/client";
import {useMe} from "../auth/useMe";
import {Button} from "../components/ui/Button";
import {Screen} from "../fate/Screen";
import {useDraftSubmit} from "../fate/useDraftSubmit";
import {MECMUA_WRITE} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
// The publish/CTA gate lives in a composer-free module so its consumers (index, nav) don't
// drag tiptap into the entry chunk — this page lazy-loads behind that split (#2523).
import {mecmuaPublishAffordance} from "./mecmua-write-gate";
import {NotFoundPage} from "./NotFoundPage";
import "./MecmuaEditorPage.css";

/**
 * The write-back selection for both mecmua write mutations. `id` is load-bearing —
 * `saveDraft` returns the fresh draft id that `publish` then references.
 */
const MecmuaEditorView = view<MecmuaPost>()({
	id: true,
	slug: true,
	title: true,
	publishedAt: true,
});

export function MecmuaEditorPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(MECMUA_WRITE, false);

	// Don't decide 404-vs-page until the flag resolves, or the 404 flashes first (the
	// MecmuaPostPage / DivanPage self-gate idiom).
	if (flagLoading) {
		return (
			<div className="kp-page">
				<div className="kp-page__inner">
					<p>yükleniyor…</p>
				</div>
			</div>
		);
	}

	if (!flagOn) return <NotFoundPage />;

	return <MecmuaEditorRoute />;
}

/** The full-post read used to reopen an author's own draft — body included so the composer seeds. */
const MecmuaOwnPostView = view<MecmuaPost>()({
	id: true,
	title: true,
	body: true,
	publishedAt: true,
});
const OwnPostsConnectionView = {items: {node: MecmuaOwnPostView}} as const;
const ownPostsRequest = {
	mecmuaMyPosts: {list: OwnPostsConnectionView, args: {first: 100}},
} as const;

/**
 * Route the editor by the `:id` param (#2544): no id ⇒ a blank editor; an id ⇒ load
 * that draft (scoped to the author's own posts) and seed the editor with it. The read
 * runs BEFORE `MecmuaEditor` mounts so the composer's initial content is ready at hook
 * time — the composer seeds content only at creation.
 */
function MecmuaEditorRoute() {
	const {id} = useParams<{id: string}>();
	if (!id) return <MecmuaEditor initialTitle="" initialBody="" />;
	return (
		<Screen
			fallback={
				<div className="kp-page">
					<div className="kp-page__inner">
						<p>yükleniyor…</p>
					</div>
				</div>
			}
			error={() => <MecmuaDraftNotFound />}
		>
			<MecmuaDraftLoader draftId={id} />
		</Screen>
	);
}

function MecmuaDraftLoader({draftId}: {draftId: string}) {
	const {mecmuaMyPosts} = useRequest(ownPostsRequest);
	const [items] = useListView(OwnPostsConnectionView, mecmuaMyPosts);
	// `mecmuaMyPosts` returns ONLY the caller's own posts, so a foreign/absent id simply
	// isn't in the list — it can't disclose another author's draft, it 404s to the author.
	const match = items.find(({node}) => String(node.id) === draftId);
	if (!match) return <MecmuaDraftNotFound />;
	return <MecmuaDraftEditor node={match.node} />;
}

function MecmuaDraftEditor({node}: {node: ViewRef<"MecmuaPost">}) {
	const post = useView(MecmuaOwnPostView, node);
	return <MecmuaEditor initialTitle={post.title} initialBody={post.body} />;
}

function MecmuaDraftNotFound() {
	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<div className="kp-mecmua-editor">
					<p className="kp-mecmua-editor__notice" role="status">
						taslak bulunamadı.
					</p>
					<Link to="/mecmua/yazilarim" className="kp-mecmua-editor__yazilarim-link">
						yazılarıma dön
					</Link>
				</div>
			</div>
		</div>
	);
}

function MecmuaEditor({initialTitle, initialBody}: {initialTitle: string; initialBody: string}) {
	const session = useSession();
	const {me} = useMe();
	const fate = useFateClient();
	const navigate = useNavigate();
	const {id} = useParams<{id: string}>();

	const [title, setTitle] = useState(initialTitle);
	const [notice, setNotice] = useState<string | null>(null);
	// The composer holds the body; markdown is read on-demand at save/publish time
	// (`getMarkdown()`), so no per-keystroke rerender is needed here. Seeded with the
	// loaded draft's markdown (empty for a fresh editor).
	const composer = useComposerEditor({content: initialBody});

	const {error, setError, inFlight, run} = useDraftSubmit({
		redirectPath: () => (id ? `/mecmua/yaz/${id}` : "/mecmua/yaz"),
	});

	// The trusted account tier off the fate `me` view (#1297) decides the publish
	// affordance: a yazar is offered publish; a çaylak / visitor / signed-out reader
	// sees the earned-gate message instead.
	const publishAffordance = mecmuaPublishAffordance(!!session.data, me?.tier);
	const titleReady = title.trim().length > 0;
	const bodyMarkdown = () => (composer ? composer.getMarkdown() : "");

	async function onSaveDraft() {
		setNotice(null);
		setError(null);
		await run(
			() =>
				fate.mutations.mecmua.saveDraft({
					input: {title: title.trim(), body: bodyMarkdown()},
					view: MecmuaEditorView,
				}),
			"taslak kaydedilemedi",
			(result) => {
				setNotice("taslak kaydedildi");
				// Land on the just-saved draft (id-addressable), not a blank `/mecmua/yaz`
				// (#2544). Each save mints a fresh row, so the saved id is new — navigate to it.
				const savedId = result?.id;
				if (savedId && String(savedId) !== id) navigate(`/mecmua/yaz/${String(savedId)}`);
			},
		);
	}

	async function onPublish() {
		setNotice(null);
		setError(null);
		// Publish operates on a draft id, so save the current content as a fresh draft
		// first, then stamp it published — this guarantees the published post matches
		// what's on screen (no stale prior-draft publish).
		await run(
			async () => {
				const saved = await fate.mutations.mecmua.saveDraft({
					input: {title: title.trim(), body: bodyMarkdown()},
					view: MecmuaEditorView,
				});
				if (saved.error) return saved;
				const draftId = saved.result?.id;
				if (!draftId) return {error: {message: "taslak kaydedilemedi"}};
				return fate.mutations.mecmua.publish({
					input: {id: draftId},
					view: MecmuaEditorView,
				});
			},
			"yazı yayımlanamadı",
			() => setNotice("yazın yayımlandı"),
		);
	}

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<div className="kp-mecmua-editor">
					<header className="kp-mecmua-editor__head">
						<div className="kp-mecmua-editor__head-row">
							<h1 className="kp-mecmua-editor__title">{id ? "yazıyı düzenle" : "yeni yazı"}</h1>
							<Link to="/mecmua/yazilarim" className="kp-mecmua-editor__yazilarim-link">
								yazılarım
							</Link>
						</div>
						<p className="kp-mecmua-editor__lede">
							uzun biçimli bir yazı yaz. istediğin an taslak olarak kaydet; hazır olunca yayımla.
						</p>
					</header>

					<div className="kp-mecmua-editor__field">
						<label className="kp-mecmua-editor__label" htmlFor="mecmua-title">
							başlık
						</label>
						<input
							id="mecmua-title"
							className="kp-mecmua-editor__title-input"
							data-testid="mecmua-editor-title"
							type="text"
							placeholder="yazının başlığı"
							value={title}
							onChange={(e) => setTitle(e.currentTarget.value)}
						/>
					</div>

					{/* The composer is a headless contenteditable region (no native label
					    slot), so a fieldset/legend names the group around it. */}
					<fieldset className="kp-mecmua-editor__field kp-mecmua-editor__fieldset">
						<legend className="kp-mecmua-editor__label">metin</legend>
						<Composer composer={composer} className="kp-mecmua-editor__body" />
					</fieldset>

					{error ? (
						<p
							className="kp-mecmua-editor__notice kp-mecmua-editor__notice--error"
							role="alert"
							data-testid="mecmua-editor-error"
						>
							{error}
						</p>
					) : null}

					{notice ? (
						<p
							className="kp-mecmua-editor__notice"
							role="status"
							data-testid="mecmua-editor-notice"
						>
							{notice}
						</p>
					) : null}

					<div className="kp-mecmua-editor__actions">
						<Button
							type="button"
							variant="tertiary"
							data-testid="mecmua-editor-save"
							loading={inFlight}
							onClick={onSaveDraft}
						>
							taslak kaydet
						</Button>

						{publishAffordance.kind === "publish" ? (
							<Button
								type="button"
								variant="primary"
								data-testid="mecmua-editor-publish"
								loading={inFlight}
								disabled={!titleReady}
								onClick={onPublish}
							>
								yayımla
							</Button>
						) : (
							<p className="kp-mecmua-editor__gate" role="note" data-testid="mecmua-editor-gate">
								{publishAffordance.message}
							</p>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
