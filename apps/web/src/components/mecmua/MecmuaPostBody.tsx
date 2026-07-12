import {ReadOnlyComposer} from "@kampus/composer";

/**
 * The mecmua reader's body — the published post's stored markdown rendered through
 * `@kampus/composer` in read-only mode (#2581): the reader is the editor with editing switched
 * off (the Medium/Notion editor≈reader parity), so write and read share ONE tiptap render path
 * and can't re-diverge (the two-render-path bug #2578, superseding its bespoke-renderer fix).
 *
 * This module is the tiptap-import boundary: `MecmuaPostPage` `React.lazy`-loads it so tiptap
 * (~156kB gz) stays OFF mecmua public first-paint (the #2523 editor lazy-split, applied to the
 * reader). Default export so `React.lazy(() => import(...))` resolves the component directly.
 */
export default function MecmuaPostBody({body}: {body: string}) {
	return <ReadOnlyComposer content={body} className="kp-prose" />;
}
