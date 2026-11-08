import type { Element } from "@oh-my-pi/pi-utils/dom";

// Type-only page-world surface: callbacks capture the real browser global after serialization.
interface BrowserDocument {
	querySelector<T extends Element = Element>(selector: string): T | null;
	querySelectorAll<T extends Element = Element>(selector: string): ArrayLike<T>;
}

export type BrowserHtmlElement = Element & {
	innerText: string;
	checkVisibility(): boolean;
};

export type BrowserButtonElement = BrowserHtmlElement & { disabled: boolean };

export type BrowserGlobals = typeof globalThis & {
	document: BrowserDocument;
	getComputedStyle(element: Element): { readonly animationName: string };
};
