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
 * The whole surface ships dark behind `MECMUA_WRITE` (default-off): the page
 * self-gates (off ⇒ 404), mirroring `MecmuaPostPage` / `DivanPage`, so the route is
 * absent until a human flips the flag at release (ADR 0083). Storage is the markdown
 * STRING the composer emits — no D1 schema change here.
 */
import {Composer, useComposerEditor} from "@kampus/composer";
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {MecmuaPost} from "../../worker/features/fate/views";
import type {Tier} from "../../worker/features/kunye/standing";
import {useSession} from "../auth/client";
import {useMe} from "../auth/useMe";
import {Button} from "../components/ui/Button";
import {useDraftSubmit} from "../fate/useDraftSubmit";
import {MECMUA_WRITE} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
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

/**
 * The publish affordance decision, factored DOM-free so the earned-gate contract —
 * publish is offered ONLY to a yazar; everyone else sees the Turkish earned-gate
 * message — is unit-testable without a DOM (the pure-extraction idiom of
 * `shouldShowOnramp` / `flagGateChild`). The tier is the trusted account level read
 * off the fate `me` view; publish is server-gated by `PublishMecmua` regardless, so
 * this only governs what the UI offers.
 */
export type MecmuaPublishAffordance = {kind: "publish"} | {kind: "gate"; message: string};

export function mecmuaPublishAffordance(
	isSignedIn: boolean,
	tier: Tier | undefined,
): MecmuaPublishAffordance {
	if (tier === "yazar") return {kind: "publish"};
	return {
		kind: "gate",
		message: isSignedIn
			? "yayımlamak için yazar olman gerekiyor — çaylakların yazıları henüz yayımlanamaz."
			: "yayımlamak için giriş yapıp yazar olman gerekiyor.",
	};
}

/**
 * Should the "yeni yazı" entry-point CTA (nav + index) be shown to this viewer (#2532)?
 * Gate parity with the editor is structural, not restated: the CTA appears exactly when
 * the write flag is live AND {@link mecmuaPublishAffordance} would offer publish (yazar
 * tier), so it never dead-ends a çaylak/visitor/signed-out reader into a page they'd be
 * publish-gated on. `MECMUA_WRITE` off, or any non-yazar/undefined tier, resolves false.
 */
export function shouldShowMecmuaWriteCta(
	flagOn: boolean,
	isSignedIn: boolean,
	tier: Tier | undefined,
): boolean {
	return flagOn && mecmuaPublishAffordance(isSignedIn, tier).kind === "publish";
}

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

	return <MecmuaEditor />;
}

function MecmuaEditor() {
	const session = useSession();
	const {me} = useMe();
	const fate = useFateClient();

	const [title, setTitle] = useState("");
	const [notice, setNotice] = useState<string | null>(null);
	// The composer holds the body; markdown is read on-demand at save/publish time
	// (`getMarkdown()`), so no per-keystroke rerender is needed here.
	const composer = useComposerEditor({content: ""});

	const {error, setError, inFlight, run} = useDraftSubmit({redirectPath: () => "/mecmua/yaz"});

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
			() => setNotice("taslak kaydedildi"),
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
						<h1 className="kp-mecmua-editor__title">yeni yazı</h1>
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
