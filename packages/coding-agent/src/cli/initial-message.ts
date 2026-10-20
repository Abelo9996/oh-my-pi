import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { Args } from "./args";

export interface InitialMessageInput {
	parsed: Args;
	fileText?: string;
	fileImages?: ImageContent[];
	stdinContent?: string;
}

export interface InitialMessageResult {
	initialMessage?: string;
	initialImages?: ImageContent[];
	/** Offset where the first positional message begins; preceding text is attachment or stdin data. */
	commandStart?: number;
}

/** Combine startup prompt sources while retaining where positional text begins. */
export function buildInitialMessage({
	parsed,
	fileText,
	fileImages,
	stdinContent,
}: InitialMessageInput): InitialMessageResult {
	const hasInitialContext = stdinContent !== undefined || fileText !== undefined || (fileImages?.length ?? 0) > 0;
	if (!hasInitialContext) {
		return {
			initialImages: undefined,
		};
	}

	let body = "";
	if (fileText !== undefined) {
		body += fileText;
	}

	const commandText = parsed.messages.shift();
	if (commandText !== undefined) {
		body += commandText;
	}

	const initialMessage =
		stdinContent !== undefined
			? body.length > 0
				? `${stdinContent}\n${body}`
				: stdinContent
			: body.length > 0
				? body
				: fileImages && fileImages.length > 0
					? ""
					: undefined;

	return {
		initialMessage,
		commandStart: (initialMessage?.length ?? 0) - (commandText?.length ?? 0),
		initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
	};
}
