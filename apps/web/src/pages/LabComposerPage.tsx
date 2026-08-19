/**
 * `/lab/composer` — NOT throwaway: this route is the permanent working demonstration of
 * `@kampus/composer`'s markdown round-trip (#2469). Nothing here imports tiptap directly;
 * the base owns that wrapping and the app supplies only chrome.
 */

import {Composer, renderTestMarkdown, useComposerEditor} from "@kampus/composer";
import {useState} from "react";
import {Badge, Button, Textarea} from "../components/ui";
import "./LabComposerPage.css";

// Seeded from the base's own round-trip fixture so the playground can't drift from it.
const SEED_MARKDOWN = renderTestMarkdown;

export function LabComposerPage() {
	const [pasted, setPasted] = useState(SEED_MARKDOWN);
	const [rev, setRev] = useState(0);

	const composer = useComposerEditor({
		content: SEED_MARKDOWN,
		onUpdate: () => setRev((n) => n + 1),
	});

	// Not dead: reading `rev` is what ties the panels below to the latest transaction.
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
						lab · composer{" "}
						<Badge variant="success" className="kp-lab__badge">
							kalıcı
						</Badge>
					</h1>
					<p className="kp-lab__lead">
						tiptap StarterKit + native v3 markdown. paste markdown, düzenle, ve JSON → markdown
						gidiş-dönüşünü canlı gör. paylaşılan @kampus/composer tabanının ilk canlı yüzü — herkese
						açık, kalıcı bir ürün parçası.
					</p>
				</header>

				<section className="kp-lab__row" aria-label="markdown yükle">
					<Textarea
						id="lab-md-in"
						className="kp-lab__textarea"
						label="markdown yapıştır"
						value={pasted}
						onChange={(e) => setPasted(e.target.value)}
						spellCheck={false}
						rows={6}
						resize="vertical"
						fullWidth
					/>
					<Button
						type="button"
						variant="primary"
						size="sm"
						className="kp-lab__btn"
						onClick={loadPasted}
					>
						editöre yükle
					</Button>
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
 * A SKETCH, deliberately inert (#2465): no `Fate.mutation`, no `/fate/live` publish. Wiring
 * one would make this a fanned write owing the live invalidation — out of scope here.
 */
type ComposerDraftRow = {
	id: string;
	authorId: string;
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
	// Not dead: this reference is what type-checks the sketched row shape.
	const _shape: ComposerDraftRow | null = null;
	void _shape;
	return (
		<section className="kp-lab__panel kp-lab__panel--sketch" aria-label="depolama taslağı">
			<h2 className="kp-lab__panel-title">depolama taslağı (fate/D1) — yalnızca eskiz</h2>
			<pre className="kp-lab__out">{sketch}</pre>
		</section>
	);
}
