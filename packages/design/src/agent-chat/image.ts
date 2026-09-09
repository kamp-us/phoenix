import type {PiImage} from "../agent-chat-bridge";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function fileAsImage(file: File, unreadable: string): Promise<PiImage> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error(unreadable));
		reader.onload = () => {
			if (typeof reader.result !== "string") {
				reject(new Error(unreadable));
				return;
			}
			const data = reader.result.split(",", 2)[1];
			if (!data) {
				reject(new Error(unreadable));
				return;
			}
			resolve({data, mimeType: file.type, name: file.name});
		};
		reader.readAsDataURL(file);
	});
}
