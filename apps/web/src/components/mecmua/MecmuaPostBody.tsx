import {ReadOnlyComposer} from "@kampus/composer";

// The tiptap-import boundary: `MecmuaPostPage` `React.lazy`-loads this module so tiptap
// (~156kB gz) stays off mecmua's public first paint (#2523). Default export so
// `React.lazy(() => import(...))` resolves the component directly.
export default function MecmuaPostBody({body}: {body: string}) {
	return <ReadOnlyComposer content={body} className="kp-prose" />;
}
