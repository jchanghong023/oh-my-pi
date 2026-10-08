/** Reduce a regional language tag to the base code accepted by Whisper. */
export function normalizeSttLanguage(language: string | undefined): string | undefined {
	const match = /^([A-Za-z]{2,3})(?:[-_][A-Za-z0-9]{1,8})*$/.exec(language ?? "");
	if (!match) return language;
	return match[1].toLowerCase();
}
