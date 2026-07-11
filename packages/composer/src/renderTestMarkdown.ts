/**
 * The canonical render-test fixture (#2477 → carried into the base, #2482): a single
 * markdown document exercising every block + inline element `baseKit()` (StarterKit +
 * `@tiptap/markdown`) actually round-trips — headings h1–h6, bold/italic/strikethrough,
 * inline + fenced code, ordered/unordered/nested lists, plain + nested blockquotes,
 * horizontal rule, and links.
 *
 * This is the SINGLE SOURCE for that content: `/lab/composer` seeds its playground from
 * this export and the base's round-trip test drives it, so the public render checklist
 * and the base fixture can never drift. A downstream consumer (mecmua / sözlük / pano)
 * reuses it to prove the base round-trips before depending on it.
 *
 * NOT included — tables and task-lists: the v1 set is StarterKit-only, which ships no
 * table/taskList node, so both are dropped by the markdown parser (tables vanish,
 * `- [ ]` degrades to a plain bullet) rather than shipped broken. Add them here only
 * when a kit that round-trips them lands (the emergent discipline, #2464).
 */
export const renderTestMarkdown = `# Composer render testi

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
