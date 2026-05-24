/**
 * The connection pagination control. Drives fate's `loadNext` and shows a
 * pending label while the page is in flight. Shared by every paginated view
 * (the pano feed, a term's definitions, a post's comments, a profile).
 */
import {useState} from "react";
import {Button} from "../components/ui/Button";

export function LoadMoreButton({
	loadNext,
	testId,
}: {
	loadNext: () => Promise<void>;
	testId?: string;
}) {
	const [loading, setLoading] = useState(false);
	return (
		<Button
			variant="tertiary"
			size="sm"
			type="button"
			disabled={loading}
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
