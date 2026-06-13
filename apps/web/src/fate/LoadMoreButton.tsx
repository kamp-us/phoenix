/** The shared connection pagination control: drives fate's `loadNext`. */
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
