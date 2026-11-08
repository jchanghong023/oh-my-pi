import { expect } from "bun:test";
import type { BrowserButtonElement, BrowserGlobals, BrowserHtmlElement } from "./core-browser-dom";
import type { NativeBrowserCase } from "./core-browser-types";

const EDITOR = '[data-testid="v4-composer-input"]';
const INPUT = `${EDITOR}[contenteditable="true"]`;
const SEND = '[data-testid="v4-composer-send"]';
const LOADING = '[data-testid="v4-timeline"] [data-testid="chat-loading"]';
const ERROR = '[data-testid="chat-error-banner"]';
const USER_ROWS = '[data-testid="v4-timeline"] [data-row-id][class~="group/user-row"]';
const ASSISTANT_TEXT =
	'[data-testid="v4-timeline"] [data-row-id][class~="group/assistant-row"] [data-conversation-selectable="true"]';

/** Exercise retained browser input, native admission, and the actual streaming message renderer. */
export async function inputScenario(native: NativeBrowserCase): Promise<void> {
	const { page, session } = native;
	const prompt = "Keep this browser draft until native admission succeeds.";
	// Neither assistant marker occurs in the prompt: a user-row echo cannot satisfy streaming assertions.
	const prefix = "Browser assistant partial response";
	const suffix = " and its final persisted continuation.";
	const acceptedUsersBefore = session.messages.filter(message => message.role === "user").length;

	await page.goto(native.url, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(INPUT, { visible: true });
	await page.click(INPUT);
	await page.keyboard.type(prompt);
	await page.waitForFunction(
		(input, send, text) => {
			const { document } = globalThis as BrowserGlobals;
			const editor = document.querySelector(input);
			const button = document.querySelector<BrowserButtonElement>(send);
			return editor?.textContent === text && button !== null && !button.disabled;
		},
		{},
		INPUT,
		SEND,
		prompt,
	);

	native.rejectNextPrompt("Core browser admission rejected before accepting the draft");
	await page.click(SEND);
	await page.waitForSelector(`${ERROR}[data-error-code="SEND_FAILED"]`, { visible: true });
	expect(await page.$eval(ERROR, element => element.textContent?.trim().length ?? 0)).toBeGreaterThan(0);
	expect(await page.$eval(INPUT, element => element.textContent)).toBe(prompt);
	expect(session.messages.filter(message => message.role === "user")).toHaveLength(acceptedUsersBefore);
	expect(
		await page.$$eval(USER_ROWS, (rows, text) => rows.filter(row => row.textContent?.includes(text)).length, prompt),
	).toBe(0);
	expect(await page.$(LOADING)).toBeNull();
	expect(session.isStreaming).toBe(false);

	const reply = native.setReply(prefix, suffix);
	try {
		await page.waitForFunction(
			send => {
				const { document } = globalThis as BrowserGlobals;
				const button = document.querySelector<BrowserButtonElement>(send);
				return button !== null && !button.disabled;
			},
			{},
			SEND,
		);
		// Resend the retained draft with the real control, without replacing its editor contents.
		await page.click(SEND);
		await page.waitForFunction(
			(assistant, partial, final, loading) => {
				const { document } = globalThis as BrowserGlobals;
				const bodies = Array.from(document.querySelectorAll<BrowserHtmlElement>(assistant));
				return (
					bodies.some(body => body.checkVisibility() && body.innerText.trim() === partial) &&
					!bodies.some(body => body.textContent?.includes(final)) &&
					document.querySelector<BrowserHtmlElement>(loading)?.checkVisibility() === true
				);
			},
			{},
			ASSISTANT_TEXT,
			prefix,
			suffix,
			LOADING,
		);
		await reply.began;
		expect(session.isStreaming).toBe(true);
		expect(await page.$(ERROR)).toBeNull();
		expect(session.messages.filter(message => message.role === "user")).toHaveLength(acceptedUsersBefore + 1);
		expect(
			await page.$$eval(
				USER_ROWS,
				(rows, text) => rows.filter(row => row.textContent?.includes(text)).length,
				prompt,
			),
		).toBe(1);

		reply.finish();
		await reply.finished;
		expect(session.isStreaming).toBe(false);
		await page.waitForFunction(
			(assistant, complete, loading, send, input) => {
				const { document } = globalThis as BrowserGlobals;
				const button = document.querySelector<BrowserButtonElement>(send);
				return (
					Array.from(document.querySelectorAll<BrowserHtmlElement>(assistant)).some(
						body => body.checkVisibility() && body.innerText.trim() === complete,
					) &&
					document.querySelector(loading) === null &&
					button !== null &&
					document.querySelector<BrowserHtmlElement>(input)?.checkVisibility() === true
				);
			},
			{},
			ASSISTANT_TEXT,
			prefix + suffix,
			LOADING,
			SEND,
			INPUT,
		);
		expect(await page.$eval(INPUT, element => element.textContent?.trim())).toBe("");

		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForFunction(
			(assistant, users, complete, text, input, loading, send) => {
				const { document } = globalThis as BrowserGlobals;
				const replies = Array.from(document.querySelectorAll<BrowserHtmlElement>(assistant));
				const prompts = Array.from(document.querySelectorAll<BrowserHtmlElement>(users));
				return (
					replies.filter(body => body.checkVisibility() && body.innerText.trim() === complete).length === 1 &&
					prompts.filter(row => row.innerText.includes(text)).length === 1 &&
					document.querySelector<BrowserHtmlElement>(input)?.checkVisibility() === true &&
					document.querySelector(loading) === null &&
					document.querySelector(send) !== null
				);
			},
			{},
			ASSISTANT_TEXT,
			USER_ROWS,
			prefix + suffix,
			prompt,
			INPUT,
			LOADING,
			SEND,
		);
		expect(session.messages.filter(message => message.role === "user")).toHaveLength(acceptedUsersBefore + 1);
		expect(await page.$eval(INPUT, element => element.textContent?.trim())).toBe("");
	} finally {
		// Release the provider even if a browser assertion fails while its stream is held open.
		reply.finish();
	}
}
