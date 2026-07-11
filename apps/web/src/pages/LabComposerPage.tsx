/**
 * `/lab/composer` — the live proof / first consumer of `@kampus/composer`, kept +
 * canonical under the `/lab/*` public convention (#2469 / PR #2474). NOT throwaway:
 * this route stays as the working demonstration of the shared headless composer base,
 * exercising its full markdown round-trip end to end. The editor is wired entirely
 * through `@kampus/composer` — the app supplies only chrome (masthead, panels, CSS);
 * the base owns the tiptap wrapping (StarterKit + `@tiptap/markdown`), so nothing here
 * imports tiptap directly.
 */

import {Composer, renderTestMarkdown, useComposerEditor} from "@kampus/composer";
import {useState} from "react";
import "./LabComposerPage.css";

// The canonical render-test content is the shared `renderTestMarkdown` fixture the base
// exports (#2482) — the single source, so this playground and `@kampus/composer`'s
// round-trip test can never drift. The panels below double as its live render checklist.
const SEED_MARKDOWN = renderTestMarkdown;

export function LabComposerPage() {
	const [pasted, setPasted] = useState(SEED_MARKDOWN);
	// Bumped on every editor transaction so the read-only round-trip panels below
	// re-derive `getMarkdown()`/`getJSON()` from the live editor state.
	const [rev, setRev] = useState(0);

	const composer = useComposerEditor({
		content: SEED_MARKDOWN,
		onUpdate: () => setRev((n) => n + 1),
	});

	// `rev` is read to tie the derivation to the latest transaction (see the state above).
	void rev;
	const markdown = composer ? composer.getMarkdown() : "";
	const json = composer ? JSON.stringify(composer.toJSON(), null, 2) : "";

	function loadPasted() {
		if (composer) composer.setContent(pasted);
	}

	return (
		<main className="kp-lab" data-testid="lab-composer-page">
			<div className="kp-lab__inner">
				<header className="kp-lab__masthead">
					<h1 className="kp-lab__title">
						lab · composer <span className="kp-lab__badge">kalıcı</span>
					</h1>
					<p className="kp-lab__lead">
						tiptap StarterKit + native v3 markdown. paste markdown, düzenle, ve JSON → markdown
						gidiş-dönüşünü canlı gör. paylaşılan @kampus/composer tabanının ilk canlı yüzü — herkese
						açık, kalıcı bir ürün parçası.
					</p>
				</header>

				<section className="kp-lab__row" aria-label="markdown yükle">
					<label className="kp-lab__label" htmlFor="lab-md-in">
						markdown yapıştır
					</label>
					<textarea
						id="lab-md-in"
						className="kp-lab__textarea"
						value={pasted}
						onChange={(e) => setPasted(e.target.value)}
						spellCheck={false}
						rows={6}
					/>
					<button type="button" className="kp-lab__btn" onClick={loadPasted}>
						editöre yükle
					</button>
				</section>

				<div className="kp-lab__grid">
					<section className="kp-lab__panel" aria-label="editör">
						<h2 className="kp-lab__panel-title">editör</h2>
						<Composer composer={composer} className="kp-lab__editor" />
					</section>

					<section className="kp-lab__panel" aria-label="getMarkdown çıktısı">
						<h2 className="kp-lab__panel-title">getMarkdown()</h2>
						<pre className="kp-lab__out">{markdown}</pre>
					</section>

					<section className="kp-lab__panel" aria-label="getJSON çıktısı">
						<h2 className="kp-lab__panel-title">getJSON()</h2>
						<pre className="kp-lab__out kp-lab__out--json">{json}</pre>
					</section>
				</div>

				<StorageSketch />
			</div>
		</main>
	);
}

/**
 * Storage SKETCH ONLY (#2465 AC) — a shape to *feel*, deliberately inert. There is no
 * wired `Fate.mutation` and no `/fate/live` publish here; a real composer draft would
 * persist through the fate mutation pattern in `apps/web/worker/features/*` and, being a
 * write over a fanned entity, MUST publish the live invalidation + be classified in
 * `apps/web/worker/features/fate-live/fanned-mutations.ts` (CLAUDE.md fanout rule). That
 * wiring is explicitly out of scope for this v1 lab route (baseKit-only, #2464).
 */
type ComposerDraftRow = {
	id: string;
	authorId: string;
	// Store BOTH: markdown as the human-editable source of truth, tiptap JSON as the
	// render-fast structural cache. The round-trip above is what proves they stay in sync.
	markdown: string;
	docJson: string;
	updatedAt: number;
};

function StorageSketch() {
	const sketch = [
		"-- D1 (sketch, not migrated):",
		"-- CREATE TABLE composer_draft (",
		"--   id TEXT PRIMARY KEY, author_id TEXT NOT NULL,",
		"--   markdown TEXT NOT NULL, doc_json TEXT NOT NULL,",
		"--   updated_at INTEGER NOT NULL",
		"-- );",
		"",
		"// fate (sketch, NOT wired — no mutation, no /fate/live publish):",
		"// Fate.mutation('composer.saveDraft', { markdown, docJson }) -> upsert row",
		"//   then publish the live invalidation (fanned-entity rule) — deferred to rich phase.",
	].join("\n");
	// Reference the row type so the sketched shape is a real, type-checked artifact.
	const _shape: ComposerDraftRow | null = null;
	void _shape;
	return (
		<section className="kp-lab__panel kp-lab__panel--sketch" aria-label="depolama taslağı">
			<h2 className="kp-lab__panel-title">depolama taslağı (fate/D1) — yalnızca eskiz</h2>
			<pre className="kp-lab__out">{sketch}</pre>
		</section>
	);
}
