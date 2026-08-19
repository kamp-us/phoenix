/**
 * `/mecmua/yaz[/:id]` — the mecmua authoring surface. Two authority tiers: any signed-in
 * user may save a private draft, but yayımla is offered only to a yazar (read off the fate
 * `me` view, never the session field) — `PublishMecmua` gates it server-side regardless.
 * Every save mints a FRESH draft row; there is no edit-in-place (#2463). Nothing here
 * imports tiptap directly. Ships dark behind `MECMUA_WRITE` (default-off; ADR 0083).
 */
import {Composer, useComposerEditor} from "@kampus/composer";
import {useState} from "react";
import {useFateClient, useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {Link, useNavigate, useParams} from "react-router";
import type {MecmuaPost} from "../../worker/features/fate/views";
import {useSession} from "../auth/client";
import {useMe} from "../auth/useMe";
import {Alert} from "../components/ui/Alert";
import {Button} from "../components/ui/Button";
import {Input} from "../components/ui/Form";
import {Screen} from "../fate/Screen";
import {useDraftSubmit} from "../fate/useDraftSubmit";
import {MECMUA_WRITE} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {mecmuaPublishAffordance} from "./mecmua-write-gate";
import {NotFoundPage} from "./NotFoundPage";
import "./MecmuaEditorPage.css";

/** `id` is load-bearing: `saveDraft` returns the fresh draft id that `publish` references. */
const MecmuaEditorView = view<MecmuaPost>()({
	id: true,
	slug: true,
	title: true,
	publishedAt: true,
});

export function MecmuaEditorPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(MECMUA_WRITE, false);

	// Don't decide 404-vs-page until the flag resolves, or the 404 flashes first.
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
 * The draft read must finish BEFORE `MecmuaEditor` mounts: the composer seeds its content
 * only at creation, so a late-arriving body would never reach the editor.
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
	// The read is author-scoped, so a foreign id simply isn't in the list — no disclosure.
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
					<Alert variant="secondary" className="kp-alert--inline kp-mecmua-editor__notice">
						taslak bulunamadı.
					</Alert>
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
	// The composer holds the body and markdown is read on demand at save time, so the body
	// is deliberately not React state — no per-keystroke rerender.
	const composer = useComposerEditor({content: initialBody});

	const {error, setError, inFlight, run} = useDraftSubmit({
		redirectPath: () => (id ? `/mecmua/yaz/${id}` : "/mecmua/yaz"),
	});

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
				// Each save mints a fresh row, so land on the new id rather than a blank editor.
				const savedId = result?.id;
				if (savedId && String(savedId) !== id) navigate(`/mecmua/yaz/${String(savedId)}`);
			},
		);
	}

	async function onPublish() {
		setNotice(null);
		setError(null);
		// Publish takes a draft id, so save first: publishing an older id would ship stale text.
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

					<Input
						id="mecmua-title"
						className="kp-mecmua-editor__field kp-mecmua-editor__title-input"
						data-testid="mecmua-editor-title"
						type="text"
						label="başlık"
						placeholder="yazının başlığı"
						value={title}
						onChange={(e) => setTitle(e.currentTarget.value)}
						fullWidth
					/>

					{/* The composer is headless with no native label slot, so fieldset/legend names it. */}
					<fieldset className="kp-mecmua-editor__field kp-mecmua-editor__fieldset">
						<legend className="kp-mecmua-editor__label">metin</legend>
						<Composer composer={composer} className="kp-mecmua-editor__body" />
					</fieldset>

					{error ? (
						<Alert
							variant="danger"
							className="kp-alert--inline kp-mecmua-editor__notice kp-mecmua-editor__notice--error"
							data-testid="mecmua-editor-error"
						>
							{error}
						</Alert>
					) : null}

					{notice ? (
						<Alert
							variant="success"
							className="kp-alert--inline kp-mecmua-editor__notice"
							data-testid="mecmua-editor-notice"
						>
							{notice}
						</Alert>
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
