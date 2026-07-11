/**
 * `/lab/composer` — the live proof / first consumer of `@kampus/composer`, kept +
 * canonical under the `/lab/*` public convention (#2469 / PR #2474). NOT throwaway:
 * this route stays as the working demonstration of the shared headless composer base,
 * exercising its full markdown round-trip end to end. The editor is wired entirely
 * through `@kampus/composer` — the app supplies only chrome (masthead, panels, CSS);
 * the base owns the tiptap wrapping (StarterKit + `@tiptap/markdown`), so nothing here
 * imports tiptap directly.
 */

import {Composer, getJSON, getMarkdown, setMarkdown, useComposerEditor} from "@kampus/composer";
import {useState} from "react";
import "./LabComposerPage.css";

// Canonical render-test content (#2477): every block + inline element the
// StarterKit + `@tiptap/markdown` set actually round-trips, so the panels below
// double as a render checklist now and a reusable fixture for the shared
// `@kampus/composer` base (#2476). Verified idempotent — `getMarkdown()` echoes
// this verbatim. NOT included: tables and task-lists — this route is StarterKit-only,
// which ships no table/taskList node, so both are dropped by the markdown parser
// (tables vanish, `- [ ]` degrades to a plain bullet) rather than shipped broken.
const SEED_MARKDOWN = `# Composer render testi

Bu örnek, StarterKit + \`@tiptap/markdown\` setinin **round-trip** ile işlediği her blok ve satır-içi öğeyi gösterir — hem şimdi bir render kontrol listesi, hem #2476'daki paylaşılan \`@kampus/composer\` tabanına taşınacak kanonik test içeriği.

## Satır içi biçimler

Paragraf içinde **kalın**, *italik*, ~~üstü çizili~~ ve \`satır içi kod\` bir arada. Bir de [kamp.us bağlantısı](https://kamp.us) burada.

### Üçüncü seviye başlık

#### Dördüncü seviye başlık

##### Beşinci seviye başlık

###### Altıncı seviye başlık

## Listeler

- birinci madde
- ikinci madde
  - iç içe madde
  - ikinci iç madde
- üçüncü madde

1. birinci adım
2. ikinci adım
  1. iç içe numaralı
  2. ikinci iç numaralı
3. üçüncü adım

## Alıntılar

> Bir alıntı bloğu — kenar çizgisi ve soluk renkle ayrışır.
>
> > İç içe alıntı ayrı bir tonda görünür.

## Kod bloğu

\`\`\`ts
export function selam(ad: string): string {
	return "merhaba, " + ad;
}
\`\`\`

## Yatay çizgi

Aşağıda bir ayraç var:

---

Ayracın altındaki paragraf.`;

export function LabComposerPage() {
	const [pasted, setPasted] = useState(SEED_MARKDOWN);
	// Bumped on every editor transaction so the read-only round-trip panels below
	// re-derive `getMarkdown()`/`getJSON()` from the live editor state.
	const [rev, setRev] = useState(0);

	const editor = useComposerEditor({
		content: SEED_MARKDOWN,
		onUpdate: () => setRev((n) => n + 1),
	});

	// `rev` is read to tie the derivation to the latest transaction (see the state above).
	void rev;
	const markdown = editor ? getMarkdown(editor) : "";
	const json = editor ? JSON.stringify(getJSON(editor), null, 2) : "";

	function loadPasted() {
		if (editor) setMarkdown(editor, pasted);
	}

	return (
		<main className="kp-lab" data-testid="lab-composer-page">
			<div className="kp-lab__inner">
				<header className="kp-lab__masthead">
					<h1 className="kp-lab__title">
						lab · composer <span className="kp-lab__badge">spike</span>
					</h1>
					<p className="kp-lab__lead">
						tiptap StarterKit + native v3 markdown. paste markdown, düzenle, ve JSON → markdown
						gidiş-dönüşünü canlı gör. atılabilir bir deneme — kalıcı bir özellik değil.
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
						<Composer editor={editor} className="kp-lab__editor" />
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
