import {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

export class Browsercloud implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'TestMu AI (Formerly LambdaTest)',
		name: 'browsercloud',
		icon: 'file:browsercloud_logo.png',
		group: ['transform'],
		version: 1,
		description:
			'Run browser automation scripts on TestMu AI Browser Cloud. Connect your existing Playwright, Puppeteer, or Selenium scripts to a scalable cloud browser infrastructure — no local setup required.',
		defaults: {
			name: 'TestMu AI (Formerly LambdaTest)',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'browsercloudApi',
				required: true,
			},
			{
				name: 'browsercloudOpenAiApi',
				required: false,
			},
			{
				name: 'browsercloudAnthropicApi',
				required: false,
			},
			{
				name: 'browsercloudGoogleGeminiApi',
				required: false,
			},
		],
		properties: [
			{
				displayName: 'Script',
				name: 'script',
				type: 'string',
				typeOptions: {
					rows: 16,
					editor: 'codeNodeEditor',
					editorLanguage: 'javaScript',
				},
				default: `// Standalone Node.js script. Imports/require work normally.
// Available in process.env:
//   LT_USERNAME, LT_ACCESS_KEY  - your Browsercloud credentials
//   N8N_WORKFLOW_NAME           - the n8n workflow's name (for dashboard labels)
//   N8N_ITEM_JSON               - the current input item as JSON (optional)
// Anything you write to stdout becomes part of the node output.

const { Browser } = require('@testmuai/browser-cloud');

const sessionName = \`\${process.env.N8N_WORKFLOW_NAME || 'n8n'}_\${new Date().toISOString().slice(0, 19)}\`;

(async () => {
  const client = new Browser();
  const session = await client.sessions.create({
    adapter: 'playwright',
    lambdatestOptions: {
      build: 'n8n-browsercloud',
      name: sessionName,
      platformName: 'Windows 11',
      browserName: 'Chrome',
      browserVersion: 'latest',
      'LT:Options': {
        username: process.env.LT_USERNAME,
        accessKey: process.env.LT_ACCESS_KEY,
        video: true,
        console: true,
      },
    },
  });

  const { browser, page } = await client.playwright.connect(session);
  try {
    await page.goto('https://news.ycombinator.com');
    console.log(JSON.stringify({ title: await page.title() }));
  } finally {
    await browser.close().catch(() => {});
    await client.sessions.release(session.id);
  }
})();`,
				required: true,
				description:
					'Standalone Node.js script. Same shape that runs locally — use require() or import for any framework. The TestMu SDK is pre-installed.',
			},
			{
				displayName: 'Continue On Script Error',
				name: 'continueOnFail',
				type: 'boolean',
				default: false,
				description:
					'Whether to keep processing remaining items if a script exits non-zero. Errors are returned in the output instead of stopping the run.',
			},
			{
				displayName: 'Timeout (ms)',
				name: 'timeoutMs',
				type: 'number',
				default: 300000,
				description:
					'Maximum runtime for the script in milliseconds. After this, the child process is killed and the script is reported as failed. Default 5 minutes.',
			},
			{
				displayName: 'Verbose Output',
				name: 'verbose',
				type: 'boolean',
				default: false,
				description:
					'When on, the output includes the raw stdout, stderr, and exit code of the script (useful for debugging). When off (default), the output is a clean summary with status, success flag, and result only.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const credentials = (await this.getCredentials('browsercloudApi')) as {
			username: string;
			accessKey: string;
		};

		// Optional LLM provider credentials — each is silently skipped when not
		// configured on the node. Scripts that don't need them never see the env
		// vars; scripts that do see them via process.env.OPENAI_API_KEY etc.
		const extraEnv: Record<string, string> = {};
		const openai = await tryGetCredential(this, 'browsercloudOpenAiApi');
		if (openai?.apiKey) extraEnv.OPENAI_API_KEY = String(openai.apiKey);
		const anthropic = await tryGetCredential(this, 'browsercloudAnthropicApi');
		if (anthropic?.apiKey) extraEnv.ANTHROPIC_API_KEY = String(anthropic.apiKey);
		const gemini = await tryGetCredential(this, 'browsercloudGoogleGeminiApi');
		if (gemini?.apiKey) {
			extraEnv.GEMINI_API_KEY = String(gemini.apiKey);
			extraEnv.GOOGLE_API_KEY = String(gemini.apiKey);
		}

		const results: INodeExecutionData[] = [];

		const workflowName = this.getWorkflow().name || 'workflow';

		for (let i = 0; i < items.length; i++) {
			const script = this.getNodeParameter('script', i) as string;
			const continueOnFail = this.getNodeParameter('continueOnFail', i) as boolean;
			const timeoutMs = this.getNodeParameter('timeoutMs', i, 300000) as number;
			const verbose = this.getNodeParameter('verbose', i, false) as boolean;

			const startedAt = Date.now();

			if (!script || script.trim() === '') {
				const processed: ProcessedOutcome = {
					success: false,
					status: 'invalid_input',
					error: 'Script is empty',
					durationMs: Date.now() - startedAt,
				};
				if (continueOnFail) {
					results.push({ json: toJson(processed, verbose), pairedItem: { item: i } });
					continue;
				}
				throw new NodeOperationError(this.getNode(), processed.error!, { itemIndex: i });
			}

			let rawOutcome: ScriptOutcome | undefined;
			let runError: Error | undefined;
			try {
				rawOutcome = await runScript(script, credentials, items[i], timeoutMs, workflowName, extraEnv);
			} catch (err) {
				runError = err as Error;
			}

			const durationMs = Date.now() - startedAt;
			let processed: ProcessedOutcome;

			if (runError) {
				const msg = runError.message;
				const isTimeout = /exceeded.*timeout|killed/i.test(msg);
				processed = {
					success: false,
					status: isTimeout ? 'timeout' : 'spawn_error',
					error: msg,
					durationMs,
				};
			} else if (rawOutcome!.exitCode === 0) {
				processed = {
					success: true,
					status: 'completed',
					result: tryParseJson(rawOutcome!.stdout),
					stdout: rawOutcome!.stdout,
					stderr: rawOutcome!.stderr,
					exitCode: rawOutcome!.exitCode,
					durationMs,
				};
			} else {
				processed = {
					success: false,
					status: 'script_error',
					error: rawOutcome!.stderr.trim() || `Script exited with code ${rawOutcome!.exitCode}`,
					stdout: rawOutcome!.stdout,
					stderr: rawOutcome!.stderr,
					exitCode: rawOutcome!.exitCode,
					durationMs,
				};
			}

			if (processed.success || continueOnFail) {
				results.push({ json: toJson(processed, verbose), pairedItem: { item: i } });
				continue;
			}

			throw new NodeOperationError(
				this.getNode(),
				`Script failed on item ${i} (${processed.status}): ${processed.error ?? '(no error message)'}`,
				{ itemIndex: i },
			);
		}

		return [results];
	}
}

interface ScriptOutcome {
	stdout: string;
	stderr: string;
	exitCode: number;
}

type OutcomeStatus = 'completed' | 'script_error' | 'timeout' | 'spawn_error' | 'invalid_input';

interface ProcessedOutcome {
	success: boolean;
	status: OutcomeStatus;
	result?: unknown;
	error?: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	durationMs: number;
}

function toJson(o: ProcessedOutcome, verbose: boolean): IDataObject {
	if (verbose) {
		const json: IDataObject = {
			success: o.success,
			status: o.status,
			durationMs: o.durationMs,
			stdout: o.stdout ?? '',
			stderr: o.stderr ?? '',
			exitCode: o.exitCode ?? -1,
		};
		if (o.result !== undefined) json.result = o.result as never;
		if (o.error !== undefined) json.error = o.error;
		return json;
	}
	const json: IDataObject = {
		success: o.success,
		status: o.status,
		durationMs: o.durationMs,
	};
	if (o.success && o.result !== undefined) json.result = o.result as never;
	if (!o.success && o.error) json.error = o.error;
	return json;
}

async function tryGetCredential(
	ctx: IExecuteFunctions,
	name: string,
): Promise<Record<string, unknown> | undefined> {
	try {
		return (await ctx.getCredentials(name)) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

async function runScript(
	script: string,
	credentials: { username: string; accessKey: string },
	item: INodeExecutionData,
	timeoutMs: number,
	workflowName: string,
	extraEnv: Record<string, string>,
): Promise<ScriptOutcome> {
	// Write the tempfile INSIDE the package directory (not /tmp) so Node's
	// module resolver — which walks up from the script's location looking for
	// node_modules — can find @testmuai/browser-cloud regardless of whether
	// the user's script uses CommonJS require() or ESM import. NODE_PATH
	// (used below) covers require() but ESM ignores NODE_PATH entirely, so
	// the script's physical location is the only thing that makes both work.
	const packageRoot = path.resolve(__dirname, '..', '..', '..');
	const tempBase = path.join(packageRoot, '.n8n-script-tmp');
	let tempDir: string;
	try {
		await fs.mkdir(tempBase, { recursive: true });
		tempDir = await fs.mkdtemp(path.join(tempBase, 'run-'));
	} catch {
		// Package dir is read-only (some Docker setups). Fall back to os tmpdir;
		// require() will still work via NODE_PATH, but ESM import won't.
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browsercloud-'));
	}
	const scriptPath = path.join(tempDir, `script-${randomUUID()}.js`);
	await fs.writeFile(scriptPath, script, 'utf8');

	// Also set NODE_PATH for CommonJS require() resolution. ESM ignores this,
	// but for CJS scripts (the bulk of n8n's installed-package shapes) it lets
	// require() find @testmuai/browser-cloud whether deps are flat or hoisted.
	const candidates = [
		path.resolve(__dirname, '..', '..', '..', 'node_modules'),
		path.resolve(__dirname, '..', '..', '..', '..', 'node_modules'),
		path.resolve(__dirname, '..', '..', '..', '..', '..', 'node_modules'),
	];
	const nodePathParts = [...candidates];
	if (process.env.NODE_PATH) nodePathParts.push(process.env.NODE_PATH);
	const nodePath = nodePathParts.join(path.delimiter);

	try {
		return await new Promise<ScriptOutcome>((resolve, reject) => {
			const child = spawn(process.execPath, [scriptPath], {
				env: {
					...process.env,
					LT_USERNAME: credentials.username,
					LT_ACCESS_KEY: credentials.accessKey,
					N8N_WORKFLOW_NAME: workflowName,
					N8N_ITEM_JSON: JSON.stringify(item.json ?? {}),
					NODE_PATH: nodePath,
					...extraEnv,
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			let stdout = '';
			let stderr = '';
			let timedOut = false;
			child.stdout.on('data', (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on('data', (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							timedOut = true;
							child.kill('SIGKILL');
					  }, timeoutMs)
					: null;

			child.on('error', (err) => {
				if (timer) clearTimeout(timer);
				reject(err);
			});
			child.on('close', (exitCode) => {
				if (timer) clearTimeout(timer);
				if (timedOut) {
					reject(new Error(`Script exceeded ${timeoutMs}ms timeout and was killed`));
					return;
				}
				resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
			});
		});
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}

function tryParseJson(s: string): unknown {
	const trimmed = s.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}
