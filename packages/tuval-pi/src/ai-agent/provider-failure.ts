/** Safe fixed guidance only; provider diagnostics never enter generic transcript state. */
export const providerFailureText = (message: unknown): string => {
	if (typeof message === "string") {
		const text = message.trim().toLowerCase();
		if (text.startsWith("you have no credits remaining."))
			return "Turn failed: the provider reports no credits remaining. Add credits in your provider account before sending again.";
		if (/^you exceeded your current quota(?:[\s.,:]|$)/.test(text))
			return "Turn failed: the provider reports an exceeded quota. Check your provider plan and billing limits before sending again.";
		if (/^rate limit (?:exceeded|reached)(?:[\s.,:]|$)/.test(text))
			return "Turn failed: the provider reports a rate limit. Wait before sending again.";
		if (/^(?:incorrect api key provided|invalid api key)(?:[\s.,:]|$)/.test(text))
			return "Turn failed: the provider rejected the API key. Check the credentials in your provider configuration.";
	}
	return "Turn failed: the provider could not complete the response. Check your provider account or try again later.";
};
