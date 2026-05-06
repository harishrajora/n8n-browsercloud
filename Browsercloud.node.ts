import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';

/**
 * Browsercloud node
 *
 * Runs a user-provided browser automation script against a TestMu AI Browser
 * Cloud session. The node is framework-agnostic: the script can use Playwright,
 * Puppeteer, Selenium, or anything else that can connect to a remote browser
 * over CDP / WebDriver. The node's only job is to:
 *
 *   1. Provide TestMu credentials and a connection endpoint to the script
 *   2. Run the script
 *   3. Return whatever the script returns, plus session metadata
 *
 * The script does its own framework imports and connection logic. The node
 * does not parse, validate, or transform the script.
 */
export class Browsercloud implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Browsercloud',
		name: 'browsercloud',
		icon: 'file:browsercloud.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["sessionMode"]}}',
		description: 'Run browser automation scripts on TestMu AI Browser Cloud',
		defaults: {
			name: 'Browsercloud',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'browsercloudApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Script',
				name: 'script',
				type: 'string',
				typeOptions: {
					rows: 14,
					editor: 'codeNodeEditor',
					editorLanguage: 'javaScript',
				},
				default: `// Your script runs with these globals already injected:
//   wsEndpoint    - CDP WebSocket URL of a fresh TestMu cloud browser
//   credentials   - { username, accessKey }
//   item          - the current n8n input item (item.json holds the data)
//   $input, $json - the current item's JSON, n8n-style
//   console       - logs are returned to n8n as 'logs' on the output
//
// Whatever value you assign to 'result' becomes the node's output.
// Use require() to load any framework installed in your n8n environment.

const { chromium } = require('playwright');
const browser = await chromium.connectOverCDP(wsEndpoint);
try {
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();
  await page.goto(item.json.url || 'https://example.com');
  result = { title: await page.title(), url: page.url() };
} finally {
  await browser.close();
}`,
				required: true,
				description:
					'Browser automation code. Assign the return value to a variable named "result". Any framework (Playwright, Puppeteer, Selenium, WebdriverIO) works as long as it is installed in the n8n environment.',
				noDataExpression: true,
			},
			{
				displayName: 'Session Mode',
				name: 'sessionMode',
				type: 'options',
				options: [
					{
						name: 'New Session Per Item',
						value: 'perItem',
						description: 'Fresh browser for every input item. Safer, slower.',
					},
					{
						name: 'Reuse Session For Run',
						value: 'reuse',
						description:
							'One browser shared across all items in this run. Faster, but cookies and login carry over.',
					},
				],
				default: 'perItem',
				description: 'How browser sessions are allocated across input items',
			},
			{
				displayName: 'Browser Options',
				name: 'browserOptions',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Browser Name',
						name: 'browserName',
						type: 'options',
						options: [
							{ name: 'Chrome', value: 'chrome' },
							{ name: 'Firefox', value: 'firefox' },
							{ name: 'Edge', value: 'MicrosoftEdge' },
						],
						default: 'chrome',
					},
					{
						displayName: 'Browser Version',
						name: 'browserVersion',
						type: 'string',
						default: 'latest',
						placeholder: 'latest, 120, 119...',
					},
					{
						displayName: 'Platform',
						name: 'platform',
						type: 'string',
						default: 'Windows 11',
						placeholder: 'Windows 11, macOS Sonoma, Linux',
					},
					{
						displayName: 'Build Name',
						name: 'build',
						type: 'string',
						default: 'n8n-browsercloud',
						description: 'Shows up on the TestMu dashboard to group related sessions',
					},
					{
						displayName: 'Session Timeout (Seconds)',
						name: 'idleTimeout',
						type: 'number',
						default: 90,
						description: 'How long the cloud session stays idle before being killed',
					},
				],
			},
			{
				displayName: 'Continue On Script Error',
				name: 'continueOnFail',
				type: 'boolean',
				default: false,
				description:
					'Whether to keep processing remaining items if one script throws. Errors are returned in the output instead of stopping the run.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const credentials = (await this.getCredentials('browsercloudApi')) as {
			username: string;
			accessKey: string;
		};
		const sessionMode = this.getNodeParameter('sessionMode', 0) as string;

		// Lazily required so the node still loads even if the SDK install is broken.
		// If TestMu's SDK exports differ from this assumed shape, this is the only
		// place that needs adjustment — see SDK adapter below.
		const sdk = createBrowserCloudClient(credentials);

		const results: INodeExecutionData[] = [];
		let sharedSession: BrowserCloudSession | null = null;

		try {
			if (sessionMode === 'reuse') {
				const browserOptions = this.getNodeParameter('browserOptions', 0, {}) as Record<
					string,
					unknown
				>;
				sharedSession = await sdk.createSession(browserOptions);
			}

			for (let i = 0; i < items.length; i++) {
				const script = this.getNodeParameter('script', i) as string;
				const browserOptions = this.getNodeParameter('browserOptions', i, {}) as Record<
					string,
					unknown
				>;
				const continueOnFail = this.getNodeParameter('continueOnFail', i) as boolean;

				let session: BrowserCloudSession;
				let ownsSession = false;

				if (sessionMode === 'reuse' && sharedSession) {
					session = sharedSession;
				} else {
					session = await sdk.createSession(browserOptions);
					ownsSession = true;
				}

				const startedAt = Date.now();
				try {
					const { result, logs } = await runUserScript(script, {
						wsEndpoint: session.wsEndpoint,
						credentials,
						item: items[i],
						$input: items[i].json,
						$json: items[i].json,
					});

					results.push({
						json: {
							result: result as never,
							sessionId: session.id,
							sessionUrl: session.dashboardUrl,
							durationMs: Date.now() - startedAt,
							logs,
						},
						pairedItem: { item: i },
					});
				} catch (err) {
					if (continueOnFail) {
						results.push({
							json: {
								error: (err as Error).message,
								sessionId: session.id,
								sessionUrl: session.dashboardUrl,
								durationMs: Date.now() - startedAt,
							},
							pairedItem: { item: i },
						});
					} else {
						throw new NodeOperationError(
							this.getNode(),
							`Script failed on item ${i}: ${(err as Error).message}`,
							{ itemIndex: i },
						);
					}
				} finally {
					if (ownsSession) {
						await session.release().catch(() => {
							/* swallow cleanup errors so they don't mask the real error */
						});
					}
				}
			}
		} finally {
			if (sharedSession) {
				await sharedSession.release().catch(() => {
					/* same — best-effort cleanup */
				});
			}
		}

		return [results];
	}
}

// ----------------------------------------------------------------------------
// Script execution
// ----------------------------------------------------------------------------

interface ScriptContext {
	wsEndpoint: string;
	credentials: { username: string; accessKey: string };
	item: INodeExecutionData;
	$input: unknown;
	$json: unknown;
}

interface ScriptOutcome {
	result: unknown;
	logs: string[];
}

/**
 * Runs the user's script in a sandboxed-ish async function. The script is wrapped
 * so the user can write top-level await and assign to `result` directly. This is
 * the same pattern n8n's built-in Code node uses.
 *
 * NOTE: this uses `new AsyncFunction(...)` which gives the script full Node.js
 * access (require, process, fs, etc.). That matches n8n's Code node behavior —
 * you trust your own n8n instance. If you need stronger isolation, swap this
 * for the `vm` module with a restricted context.
 */
async function runUserScript(script: string, ctx: ScriptContext): Promise<ScriptOutcome> {
	const logs: string[] = [];
	const sandboxedConsole = {
		log: (...args: unknown[]) => logs.push(args.map(stringify).join(' ')),
		warn: (...args: unknown[]) => logs.push('[warn] ' + args.map(stringify).join(' ')),
		error: (...args: unknown[]) => logs.push('[error] ' + args.map(stringify).join(' ')),
		info: (...args: unknown[]) => logs.push(args.map(stringify).join(' ')),
	};

	// eslint-disable-next-line @typescript-eslint/no-implied-eval
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
		...args: string[]
	) => (...fnArgs: unknown[]) => Promise<unknown>;

	const fn = new AsyncFunction(
		'wsEndpoint',
		'credentials',
		'item',
		'$input',
		'$json',
		'console',
		'require',
		`let result;\n${script}\nreturn result;`,
	);

	const result = await fn(
		ctx.wsEndpoint,
		ctx.credentials,
		ctx.item,
		ctx.$input,
		ctx.$json,
		sandboxedConsole,
		require,
	);

	return { result, logs };
}

function stringify(v: unknown): string {
	if (typeof v === 'string') return v;
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

// ----------------------------------------------------------------------------
// Browser Cloud SDK adapter
// ----------------------------------------------------------------------------
//
// This is the ONE place in the codebase that touches the TestMu SDK. The
// public API surface of @testmuai/browser-cloud isn't fully documented yet,
// so this adapter is built against the *industry-standard* CDP WebSocket
// pattern that every comparable provider (Browserbase, Browserless, Scrapfly,
// SteelDev) exposes. When the actual SDK shape is confirmed, only this
// adapter needs to change — the node code above is unaffected.
//
// What the adapter must produce:
//   createSession(opts) -> { id, wsEndpoint, dashboardUrl, release() }

interface BrowserCloudSession {
	id: string;
	wsEndpoint: string;
	dashboardUrl: string;
	release: () => Promise<void>;
}

interface BrowserCloudClient {
	createSession: (opts: Record<string, unknown>) => Promise<BrowserCloudSession>;
}

function createBrowserCloudClient(creds: {
	username: string;
	accessKey: string;
}): BrowserCloudClient {
	// Try the official SDK first. If its shape doesn't match what we expect
	// (or it's not installed), fall back to the documented WebSocket URL pattern.
	let sdk: any;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		sdk = require('@testmuai/browser-cloud');
	} catch {
		sdk = null;
	}

	if (sdk?.BrowserCloud) {
		const client = new sdk.BrowserCloud({
			username: creds.username,
			accessKey: creds.accessKey,
		});

		return {
			async createSession(opts) {
				const session = await client.sessions.create(opts);
				return {
					id: session.id,
					wsEndpoint: session.wsEndpoint ?? session.connectUrl,
					dashboardUrl:
						session.dashboardUrl ??
						`https://automation.lambdatest.com/test?testID=${session.id}`,
					release: () => client.sessions.release(session.id),
				};
			},
		};
	}

	// Fallback: build the CDP WebSocket URL by hand.
	// Auth is HTTP Basic in the URL, the same way Browserbase / Browserless do it.
	return {
		async createSession(opts) {
			const params = new URLSearchParams();
			if (opts.browserName) params.set('browser', String(opts.browserName));
			if (opts.browserVersion) params.set('version', String(opts.browserVersion));
			if (opts.platform) params.set('platform', String(opts.platform));
			if (opts.build) params.set('build', String(opts.build));

			const auth = `${encodeURIComponent(creds.username)}:${encodeURIComponent(creds.accessKey)}`;
			const wsEndpoint = `wss://${auth}@cdp.lambdatest.com/?${params.toString()}`;

			// Without the SDK we don't get a real session id until the script connects,
			// so we mint a placeholder. The TestMu dashboard surfaces it once the
			// browser activity flushes.
			const id = `pending-${Date.now()}`;
			return {
				id,
				wsEndpoint,
				dashboardUrl: 'https://automation.lambdatest.com/build',
				release: async () => {
					/* CDP-only flow has no explicit release call; the browser auto-closes */
				},
			};
		},
	};
}
