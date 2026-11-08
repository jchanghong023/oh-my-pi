// Imported only by the preview's @pierre/diffs transforms, never installed globally.
export const supportsDiffsStyleSheets =
	typeof CSSStyleSheet !== "undefined" &&
	typeof CSSStyleSheet.prototype.replaceSync === "function" &&
	typeof ShadowRoot !== "undefined" &&
	"adoptedStyleSheets" in ShadowRoot.prototype;

export function appendDiffsStyle(root: ShadowRoot, css: string) {
	const style = root.ownerDocument.createElement("style");
	style.textContent = css;
	root.appendChild(style);
}

export function replaceDiffsChildren(element: Element, ...children: (Node | string)[]) {
	if (typeof element.replaceChildren === "function") {
		element.replaceChildren(...children);
		return;
	}
	// Assemble before removing children: callers may pass an existing child back in.
	const fragment = element.ownerDocument.createDocumentFragment();
	for (const child of children) {
		fragment.appendChild(typeof child === "string" ? element.ownerDocument.createTextNode(child) : child);
	}
	element.textContent = "";
	element.appendChild(fragment);
}

export function legacyDiffsThemeCSS(themeCSS: string, themeType = "system", scrollbarGutter?: number) {
	const scheme = (dark: boolean) => `:host{--csstools-color-scheme--light:${dark ? " " : "initial"};}`;
	const fontStyles = (type: string) => `[data-line] span,[data-edit-prediction-suffix] span{
		font-weight:var(--diffs-token-${type}-font-weight,inherit);
		font-style:var(--diffs-token-${type}-font-style,inherit);
		text-decoration:var(--diffs-token-${type}-text-decoration,inherit);
	}`;
	return `${scheme(themeType === "dark")}
		${fontStyles(themeType === "dark" ? "dark" : "light")}
		${themeType === "system" ? `@media(prefers-color-scheme:dark){${scheme(true)}${fontStyles("dark")}}` : ""}
		:host{--diffs-scrollbar-gutter-measured:${scrollbarGutter == null ? "var(--diffs-scrollbar-gutter-fallback)" : `${scrollbarGutter}px`};${themeCSS}}`;
}
