import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';
import { randomUUID } from 'crypto';
import {
	getOrCreateSession,
	releaseSession,
	buildSnapshot,
	INTERACTIVE_SELECTOR,
	type ManagedSession,
} from '../_shared/sessionManager';

/**
 * Single tool the AI Agent connects to. The Agent picks an action per call;
 * the node dispatches internally and returns a consistent response shape that
 * always includes the post-action page snapshot, so the Agent rarely needs to
 * call snapshot separately.
 */
export class BrowsercloudAgent implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Browsercloud Agent',
		name: 'browsercloudAgent',
		icon: 'file:browsercloud_logo.png',
		group: ['transform'],
		version: 1,
		description:
			'Drive a TestMu Browsercloud cloud browser from an AI Agent. One tool, multiple actions: navigate, snapshot, click, type, get_text, screenshot. The cloud session is created on first call and reused across the workflow execution.',
		defaults: { name: 'Browsercloud Agent' },
		inputs: ['main'],
		outputs: ['main'],
		usableAsTool: true,
		credentials: [{ name: 'browsercloudApi', required: true }],
		properties: [
			{
				displayName: 'Session Scope',
				name: 'sessionScope',
				type: 'options',
				default: 'execution',
				description:
					'When to create a new Browsercloud cloud browser. "Per Workflow Execution" (default) shares one browser across all AI tool calls within a single n8n execution — the right choice for an AI Agent loop. "Per Tool Call" creates a fresh browser for every invocation and releases it at the end (stateless; AI cannot navigate then click).',
				options: [
					{
						name: 'Per Workflow Execution (Shared)',
						value: 'execution',
						description: 'One browser per n8n execution; reused across AI tool calls',
					},
					{
						name: 'Per Tool Call (New Each Time)',
						value: 'call',
						description: 'Brand-new browser for every invocation; released at end',
					},
				],
			},
			{
				displayName: 'Action',
				name: 'action',
				type: 'options',
				default: '={{ $fromAI("action", "What to do in the browser. One of: navigate, snapshot, click, type, get_text, screenshot.", "string") }}',
				required: true,
				description:
					'Filled automatically by the connected AI model. One of: navigate, snapshot, click, type, get_text, screenshot.',
				options: [
					{
						name: 'Navigate',
						value: 'navigate',
						description: 'Open a URL in the cloud browser',
					},
					{
						name: 'Snapshot',
						value: 'snapshot',
						description:
							'Get a numbered list of clickable / fillable elements on the current page',
					},
					{
						name: 'Click',
						value: 'click',
						description: 'Click an element by its ref number from the latest snapshot',
					},
					{
						name: 'Type',
						value: 'type',
						description: 'Type text into an input element by ref',
					},
					{
						name: 'Get Text',
						value: 'get_text',
						description: 'Read text from a specific ref or the whole page',
					},
					{
						name: 'Screenshot',
						value: 'screenshot',
						description: 'Capture a base64 PNG of the current page (for vision models)',
					},
				],
			},
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				default: '={{ $fromAI("url", "Absolute URL to open. Used when action=navigate; ignored otherwise.", "string") }}',
				placeholder: 'https://example.com',
				description: 'Filled by the AI when action=navigate.',
				displayOptions: { show: { action: ['navigate'] } },
			},
			{
				displayName: 'Ref',
				name: 'ref',
				type: 'number',
				default: '={{ $fromAI("ref", "Element ref number from the latest snapshot. Used for click, type, and optionally get_text.", "number") }}',
				description:
					'Filled by the AI for click, type, and (optionally) get_text. Refs come from the latest snapshot.',
				displayOptions: { show: { action: ['click', 'type', 'get_text'] } },
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				default: '={{ $fromAI("text", "Text to type into the input element. Used when action=type.", "string") }}',
				description: 'Filled by the AI when action=type.',
				displayOptions: { show: { action: ['type'] } },
			},
			{
				displayName: 'Press Enter After Typing',
				name: 'submit',
				type: 'boolean',
				default: '={{ $fromAI("submit", "Press Enter after typing (e.g. to submit a search). Used when action=type.", "boolean") }}',
				description: 'Filled by the AI when action=type.',
				displayOptions: { show: { action: ['type'] } },
			},
			{
				displayName: 'Max Text Length',
				name: 'maxLength',
				type: 'number',
				default: 4000,
				description: 'Truncate get_text result to this many characters',
				displayOptions: { show: { action: ['get_text'] } },
			},
			{
				displayName: 'Full Page Screenshot',
				name: 'fullPage',
				type: 'boolean',
				default: '={{ $fromAI("fullPage", "Capture the entire scrollable page (true) or just the viewport (false). Used when action=screenshot.", "boolean") }}',
				description: 'Filled by the AI when action=screenshot.',
				displayOptions: { show: { action: ['screenshot'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const credentials = (await this.getCredentials('browsercloudApi')) as {
			username: string;
			accessKey: string;
		};
		const workflowExecutionId = this.getExecutionId();
		const out: INodeExecutionData[] = [];

		for (let i = 0; i < Math.max(items.length, 1); i++) {
			const action = this.getNodeParameter('action', i) as string;
			const sessionScope = this.getNodeParameter('sessionScope', i, 'execution') as
				| 'execution'
				| 'call';

			// Per-call scope means a unique key for every invocation -> fresh remote session
			// every time. Per-execution scope reuses the workflow execution ID so all AI tool
			// calls within one n8n run share one browser.
			const sessionKey =
				sessionScope === 'call'
					? `call-${workflowExecutionId || 'noexec'}-${randomUUID()}`
					: workflowExecutionId || `exec-fallback-${randomUUID()}`;

			let session: ManagedSession | undefined;
			try {
				const workflowName = this.getWorkflow().name || 'workflow';
				const timestamp = new Date().toISOString().replace(/[:.T]/g, '-').slice(0, 19);
				session = await getOrCreateSession(sessionKey, credentials, {
					sessionName: `${workflowName}_${timestamp}`,
				});
				const result = await dispatch(action, i, this, session);
				out.push({
					json: {
						action,
						sessionScope,
						sessionKey,
						workflowExecutionId,
						url: session.page.url(),
						title: await session.page.title().catch(() => ''),
						sessionId: session.sessionId,
						dashboardUrl: session.dashboardUrl,
						...result,
					},
					pairedItem: { item: i },
				});
			} catch (err) {
				throw new NodeOperationError(
					this.getNode(),
					`Browsercloud Agent (${action}) failed: ${(err as Error).message}`,
					{ itemIndex: i },
				);
			} finally {
				if (sessionScope === 'call' && session) {
					await releaseSession(sessionKey).catch(() => {
						/* best effort */
					});
				}
			}
		}
		return [out];
	}
}

async function dispatch(
	action: string,
	itemIndex: number,
	ctx: IExecuteFunctions,
	session: ManagedSession,
): Promise<Record<string, unknown>> {
	switch (action) {
		case 'navigate': {
			const url = (ctx.getNodeParameter('url', itemIndex) as string).trim();
			if (!url) throw new Error('URL is required for navigate');
			await session.page.goto(url, { waitUntil: 'domcontentloaded' });
			session.refs = await buildSnapshot(session.page);
			return { snapshot: formatSnapshot(session) };
		}
		case 'snapshot': {
			session.refs = await buildSnapshot(session.page);
			return { snapshot: formatSnapshot(session), elements: session.refs };
		}
		case 'click': {
			const ref = Number(ctx.getNodeParameter('ref', itemIndex));
			const target = requireRef(session, ref);
			const locator = session.page.locator(INTERACTIVE_SELECTOR).nth(target.index);
			let mode: 'normal' | 'forced' = 'normal';
			try {
				await locator.click({ timeout: 10000 });
			} catch (err) {
				const msg = (err as Error).message;
				// Common interception/visibility cases — retry with force so an unexpected
				// overlay doesn't burn 30s. The forced flag is reported back so the agent
				// can react if needed.
				if (
					/intercepts pointer events|element is not visible|outside of the viewport|element is not stable/i.test(
						msg,
					)
				) {
					mode = 'forced';
					await locator.click({ force: true, timeout: 5000 });
				} else {
					throw err;
				}
			}
			await session.page.waitForLoadState('domcontentloaded').catch(() => {
				/* not all clicks navigate */
			});
			session.refs = await buildSnapshot(session.page);
			return {
				clicked: { ref, tag: target.tag, text: target.text, mode },
				snapshot: formatSnapshot(session),
			};
		}
		case 'type': {
			const ref = Number(ctx.getNodeParameter('ref', itemIndex));
			const text = ctx.getNodeParameter('text', itemIndex) as string;
			const submit = ctx.getNodeParameter('submit', itemIndex, false) as boolean;
			const target = requireRef(session, ref);
			const locator = session.page.locator(INTERACTIVE_SELECTOR).nth(target.index);
			try {
				await locator.fill(text, { timeout: 10000 });
			} catch (err) {
				const msg = (err as Error).message;
				// Surface a clear reason fast instead of waiting the full 30s.
				if (/element is not enabled|not editable|disabled/i.test(msg)) {
					throw new Error(
						`Element ref ${ref} (<${target.tag}> "${target.text}") is not editable (disabled / readonly). Run snapshot and pick a different input.`,
					);
				}
				throw err;
			}
			if (submit) {
				await locator.press('Enter');
				await session.page.waitForLoadState('domcontentloaded').catch(() => {
					/* ignore */
				});
			}
			session.refs = await buildSnapshot(session.page);
			return {
				typed: { ref, text, submit },
				snapshot: formatSnapshot(session),
			};
		}
		case 'get_text': {
			const ref = Number(ctx.getNodeParameter('ref', itemIndex, 0));
			const maxLength = Number(ctx.getNodeParameter('maxLength', itemIndex, 4000));
			let text: string;
			if (ref && ref > 0) {
				const target = requireRef(session, ref);
				text =
					(await session.page.locator(INTERACTIVE_SELECTOR).nth(target.index).innerText()) ?? '';
			} else {
				text = await session.page.evaluate(() => document.body.innerText || '');
			}
			const trimmed = text.replace(/\s+/g, ' ').trim();
			return {
				text: trimmed.slice(0, maxLength),
				length: trimmed.length,
				truncated: trimmed.length > maxLength,
			};
		}
		case 'screenshot': {
			const fullPage = ctx.getNodeParameter('fullPage', itemIndex, false) as boolean;
			const buf = await session.page.screenshot({ fullPage });
			return { image: buf.toString('base64'), fullPage };
		}
		default:
			throw new Error(`Unknown action: ${action}`);
	}
}

function requireRef(session: ManagedSession, ref: number) {
	if (!Number.isInteger(ref) || ref < 1) {
		throw new Error(`Ref must be a positive integer, got ${ref}`);
	}
	const target = session.refs.find((r) => r.ref === ref);
	if (!target) {
		throw new Error(
			`No element with ref ${ref}. Run snapshot to refresh refs (current count: ${session.refs.length}).`,
		);
	}
	return target;
}

function formatSnapshot(session: ManagedSession): string {
	if (!session.refs.length) return '(no interactive elements found)';
	return session.refs.map((r) => `${r.ref}. <${r.tag}> [${r.role}] ${r.text}`).join('\n');
}
