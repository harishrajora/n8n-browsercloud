/**
 * Per-execution Browsercloud session manager shared by all tool nodes.
 *
 * Each tool node calls getOrCreateSession(executionId, credentials) on every
 * invocation. The first call provisions a TestMu cloud browser via the SDK,
 * connects via Playwright, and caches { browser, page, refs } keyed by the
 * workflow execution ID. Subsequent calls within the same execution reuse it,
 * giving the AI Agent a persistent browser across its tool calls.
 *
 * An idle reaper releases sessions that have been silent for IDLE_TIMEOUT_MS
 * to cap cost from agents that never explicitly clean up.
 */

import type { Browser as PWBrowser, Page } from 'playwright-core';

export interface SessionCredentials {
	username: string;
	accessKey: string;
}

export interface SessionOptions {
	build?: string;
	sessionName?: string;
	platformName?: string;
	browserName?: string;
	browserVersion?: string;
	timeout?: number;
}

export interface SnapshotItem {
	ref: number;
	tag: string;
	role: string;
	text: string;
	index: number;
}

export interface ManagedSession {
	sessionId: string;
	dashboardUrl?: string;
	browser: PWBrowser;
	page: Page;
	refs: SnapshotItem[];
	lastActivity: number;
	release: () => Promise<void>;
}

const sessions = new Map<string, ManagedSession>();

// Tracks in-flight session creations so concurrent calls for the same
// executionId share one provisioning Promise. Without this, parallel tool
// calls (Gemini / Claude can fire multiple tool calls in one "thinking" step)
// each see an empty cache, each provision a fresh cloud session, and only one
// ends up in the Map — the rest leak as orphan sessions on the dashboard.
const inflight = new Map<string, Promise<ManagedSession>>();

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

let reaperStarted = false;
function startReaper(): void {
	if (reaperStarted) return;
	reaperStarted = true;
	const interval = setInterval(() => {
		const now = Date.now();
		for (const [executionId, managed] of sessions) {
			if (now - managed.lastActivity > IDLE_TIMEOUT_MS) {
				managed.release().catch(() => {
					/* best effort */
				});
				sessions.delete(executionId);
			}
		}
	}, 60_000);
	interval.unref();
}

export async function getOrCreateSession(
	executionId: string,
	credentials: SessionCredentials,
	opts: SessionOptions = {},
): Promise<ManagedSession> {
	startReaper();

	const existing = sessions.get(executionId);
	if (existing) {
		existing.lastActivity = Date.now();
		return existing;
	}

	// Dedupe concurrent creation: if another caller is already provisioning a
	// session for this executionId, await its Promise instead of starting a new
	// one. Failure unsets the entry so retries can run.
	const pending = inflight.get(executionId);
	if (pending) return pending;

	const creation = provisionSession(executionId, credentials, opts);
	inflight.set(executionId, creation);
	try {
		const managed = await creation;
		sessions.set(executionId, managed);
		return managed;
	} finally {
		inflight.delete(executionId);
	}
}

async function provisionSession(
	executionId: string,
	credentials: SessionCredentials,
	opts: SessionOptions,
): Promise<ManagedSession> {
	// The @testmuai/browser-cloud SDK reads LT credentials from process.env.LT_USERNAME
	// and process.env.LT_ACCESS_KEY when building the cloud WebSocket URL. Unlike the
	// script-based node (which spawns a child with these env vars set), this node runs
	// in-process, so we must export them ourselves before sessions.create() — otherwise
	// the SDK falls back to "generic_user"/"generic_key" and the cloud rejects with 401.
	process.env.LT_USERNAME = credentials.username;
	process.env.LT_ACCESS_KEY = credentials.accessKey;

	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { Browser } = require('@testmuai/browser-cloud');
	const client = new Browser();

	const session = await client.sessions.create({
		adapter: 'playwright',
		lambdatestOptions: {
			build: opts.build || 'n8n-browsercloud',
			name: opts.sessionName || `n8n-agent-${executionId.slice(0, 8)}`,
			platformName: opts.platformName || 'Windows 11',
			browserName: opts.browserName || 'Chrome',
			browserVersion: opts.browserVersion || 'latest',
			'LT:Options': {
				username: credentials.username,
				accessKey: credentials.accessKey,
				video: true,
				console: true,
			},
		},
		timeout: opts.timeout || 600000,
	});

	const connection = await client.playwright.connect(session);
	const browser: PWBrowser = connection.browser;
	const page: Page =
		connection.page ??
		(await (async () => {
			const ctx = browser.contexts()[0] ?? (await browser.newContext());
			return ctx.pages()[0] ?? (await ctx.newPage());
		})());

	return {
		sessionId: session.id,
		dashboardUrl:
			(session as { dashboardUrl?: string }).dashboardUrl ??
			`https://automation.lambdatest.com/test?testID=${session.id}`,
		browser,
		page,
		refs: [],
		lastActivity: Date.now(),
		release: async () => {
			try {
				await browser.close();
			} catch {
				/* ignore */
			}
			try {
				await client.sessions.release(session.id);
			} catch {
				/* ignore */
			}
		},
	};
}

export function getSession(executionId: string): ManagedSession | undefined {
	const s = sessions.get(executionId);
	if (s) s.lastActivity = Date.now();
	return s;
}

export async function releaseSession(executionId: string): Promise<void> {
	const s = sessions.get(executionId);
	if (!s) return;
	await s.release();
	sessions.delete(executionId);
}

/**
 * CSS selector that matches anything plausibly interactive. Used by both the
 * snapshot tool (to enumerate elements) and the click/type tools (to re-query
 * by index) so refs stay consistent.
 */
export const INTERACTIVE_SELECTOR =
	'a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [tabindex="0"]';

export async function buildSnapshot(page: Page): Promise<SnapshotItem[]> {
	const raw = (await page.evaluate((selector: string) => {
		const els = Array.from(document.querySelectorAll(selector));
		return els.map((el, idx) => {
			const tag = el.tagName.toLowerCase();
			const inputType = (el.getAttribute('type') || '').toLowerCase();

			// Drop elements the agent can't or shouldn't interact with:
			//   - disabled inputs/buttons/etc. (DOM `disabled` property OR aria-disabled)
			//   - aria-hidden / [hidden] elements
			//   - <input type="hidden"> honeypots
			// These would otherwise cause fill() / click() to wait the full 30s.
			const isDisabled =
				('disabled' in el && (el as HTMLInputElement).disabled) ||
				el.getAttribute('aria-disabled') === 'true';
			const isHidden =
				el.getAttribute('aria-hidden') === 'true' ||
				(el as HTMLElement).hidden ||
				(tag === 'input' && inputType === 'hidden');
			if (isDisabled || isHidden) {
				return { idx, tag, role: tag, text: '', visible: false, hittable: false };
			}

			const rect = el.getBoundingClientRect();
			const visible = rect.width > 0 && rect.height > 0;

			// Hit-test the center of the element. If the topmost element at that
			// point is something else (and not a descendant of ours), the element
			// is covered by a modal / overlay / popover and a real user click
			// would land on the cover instead. Excluding these prevents the agent
			// from picking elements it can't actually interact with.
			let hittable = false;
			if (visible) {
				const cx = rect.left + rect.width / 2;
				const cy = rect.top + rect.height / 2;
				const inViewport = cy >= 0 && cy < window.innerHeight && cx >= 0 && cx < window.innerWidth;
				if (inViewport) {
					const top = document.elementFromPoint(cx, cy);
					hittable = !!top && (top === el || el.contains(top) || top.contains(el));
				} else {
					// Out of viewport: assume hittable; Playwright auto-scrolls before clicking.
					hittable = true;
				}
			}

			const baseRole = el.getAttribute('role') || tag;
			// Readonly inputs (date pickers, destination autocompletes, custom dropdowns)
			// are visible and clickable but reject fill(). Tagging the role tells the
			// agent to click them — typically opening a popup with a real input — instead
			// of trying to type into them directly.
			const isReadOnly = 'readOnly' in el && (el as HTMLInputElement).readOnly;
			const role = isReadOnly ? `${baseRole} (readonly)` : baseRole;
			const text = (
				(el as HTMLElement).innerText ||
				(el as HTMLInputElement).value ||
				(el as HTMLInputElement).placeholder ||
				el.getAttribute('aria-label') ||
				el.getAttribute('title') ||
				''
			)
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 120);
			return { idx, tag, role, text, visible, hittable };
		});
	}, INTERACTIVE_SELECTOR)) as Array<{
		idx: number;
		tag: string;
		role: string;
		text: string;
		visible: boolean;
		hittable: boolean;
	}>;

	return raw
		.filter((r) => r.visible && r.hittable)
		.map((r, i) => ({ ref: i + 1, tag: r.tag, role: r.role, text: r.text, index: r.idx }));
}
