/**
 * React 19's `@types/react` removed the index signature from `CSSProperties`
 * for closed CSSType typing — which means CSS custom properties (`--foo`) no
 * longer type-check on `style={{ ... }}`. The upstream guidance is to add the
 * index signature back via module augmentation (see the comment on
 * `CSSProperties` in `@types/react/index.d.ts`). This lets us write
 * `style={{ "--swatch-color": color }}` with no cast.
 */
import "react";

declare module "react" {
	interface CSSProperties {
		[customProperty: `--${string}`]: string | number | undefined;
	}
}
