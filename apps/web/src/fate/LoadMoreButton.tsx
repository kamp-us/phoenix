import {Button} from "@kampus/design";
import {useState} from "react";

/**
 * `ariaLabel` names WHAT the next page holds when the visible `daha fazla` is ambiguous on its
 * own — a letter index's control sits under a heading a screen reader has long left behind, so
 * the bare label would announce with no subject (#9267). `aria-busy` rides the pending state so
 * the wait is announced, not just painted as a disabled control.
 */
export function LoadMoreButton({
	loadNext,
	testId,
	ariaLabel,
}: {
	loadNext: () => Promise<void>;
	testId?: string;
	ariaLabel?: string;
}) {
	const [loading, setLoading] = useState(false);
	return (
		<Button
			variant="tertiary"
			size="sm"
			type="button"
			disabled={loading}
			aria-label={ariaLabel}
			aria-busy={loading}
			onClick={async () => {
				setLoading(true);
				try {
					await loadNext();
				} finally {
					setLoading(false);
				}
			}}
			data-testid={testId}
		>
			{loading ? "yükleniyor…" : "daha fazla"}
		</Button>
	);
}
