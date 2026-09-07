import {Markdown} from "@kampus/design";
import type * as React from "react";
import {defineExhibit} from "../exhibit";

/**
 * The source covers every block the renderer emits that a reviewer has to be able to see at a
 * glance — bold, a link, inline code, a table, a list, a fenced block — because the stage is the
 * only place this component is judged rendered rather than through jsdom.
 *
 * The two mermaid fences are both of that block's outcomes (#8128): the first draws, so the stage
 * shows the diagram, its token-themed palette and the `<details>` source disclosure; the second is
 * an author's typo, so it shows the fence still readable under mermaid's own parse reason. jsdom
 * lays out no text and has no 2D canvas, so neither outcome exists anywhere but here.
 */
const SAMPLE = `# Ajanın yanıtı

**Kalın metin**, bir [bağlantı](https://github.com/kamp-us/phoenix) ve satır içi \`kod\` aynı
paragrafta.

| Kapı | Durum | Gecikme |
| --- | :---: | ---: |
| \`/fate\` | açık | 12 ms |
| \`/fate/live\` | açık | 48 ms |
| \`/api/health\` | kapalı | — |

- Listenin ilk maddesi
- İkinci madde, içinde \`inline\` kod
- Üçüncü madde

\`\`\`ts
export const greet = (name: string): string => {
	return \`merhaba, \${name}\`;
};
\`\`\`

\`\`\`mermaid
graph TD
	A[İstek] --> B{Oturum var mı?}
	B -->|evet| C[Yanıt]
	B -->|hayır| D[Giriş]
\`\`\`

\`\`\`mermaid
graph TD
	A[Kapı] --< B[Kuyruk]
\`\`\`
`;

export const markdownExhibit = defineExhibit<React.ComponentProps<typeof Markdown>>({
	id: "markdown",
	title: "Markdown",
	summary:
		"Ajan çıktısı için salt-okunur markdown bloğu — kaynaktaki ham HTML metin olarak basılır.",
	component: Markdown,
	knobs: {
		headingBase: {kind: "number", label: "Heading base", default: 2, min: 1, max: 6, step: 1},
		breaks: {kind: "boolean", label: "Breaks", default: false},
	},
	fixedProps: {children: SAMPLE},
});
