# n8n-nodes-browsercloud

n8n community nodes for [TestMu AI Browser Cloud](https://www.testmuai.com/browser-cloud/) (formerly LambdaTest). Drive real cloud browsers from n8n workflows — either by running your own automation scripts, or by giving an AI Agent tools to browse the web autonomously.

## What's in the package

Two nodes:

| Node | Use it when |
|---|---|
| **Browsercloud** | You have a JavaScript automation script (Playwright / Puppeteer / Selenium / anything) and want to run it on a cloud browser. |
| **Browsercloud Agent** | You want an AI Agent (Gemini / Claude / OpenAI / etc.) to drive the browser autonomously via tool calls (`navigate`, `click`, `type`, …). |

Plus one credential type, **Browsercloud (TestMu AI) API**, shared by both.

## Install

In your self-hosted n8n instance, go to **Settings → Community Nodes → Install** and enter:

```
n8n-nodes-browsercloud
```

Or from the command line in your n8n install directory:

```
npm install n8n-nodes-browsercloud
```

Restart n8n.

> **Note:** the **Browsercloud Agent** node uses Playwright internally. `playwright-core` is bundled as a dependency, so you don't need to install it separately. The **Browsercloud** script-runner node lets you `require()` any framework — install whichever ones your scripts use (`playwright`, `puppeteer-core`, `selenium-webdriver`, `webdriverio`).

## Credentials

Add a **Browsercloud (TestMu AI) API** credential with:

- **Username** — your TestMu username
- **Access Key** — your TestMu access key

Find both in your TestMu account profile.

---

## Node: Browsercloud (script-runner)

Runs an arbitrary Node.js script in a child process with TestMu credentials available via environment variables. The script handles its own session lifecycle — create the session, drive the browser, release the session. No framework lock-in.

### Configuration

- **Script** — your JavaScript code. Default contains a working Playwright example you can paste-and-go.
- **Continue On Script Error** — when on, non-zero exit codes are returned as error items instead of failing the workflow.

### What the script has access to

The script runs in a child `node` process spawned by the node. The following are available:

- `process.env.LT_USERNAME` and `process.env.LT_ACCESS_KEY` — your credentials, ready to use in `'LT:Options'`.
- `process.env.N8N_ITEM_JSON` — the current n8n input item as a JSON string (optional, read if you need it).
- `require('@testmuai/browser-cloud')` — the TestMu SDK is pre-installed.
- `require('playwright')` / `require('puppeteer-core')` / `require('selenium-webdriver')` — whatever frameworks you installed in your n8n environment.
- Any other npm package installed in your n8n's `node_modules`.

### Output per item

```json
{
  "result": <parsed JSON from stdout, if any>,
  "stdout": "raw stdout from the script",
  "stderr": "raw stderr from the script",
  "exitCode": 0,
  "durationMs": 4280
}
```

If your script does `console.log(JSON.stringify({foo: 'bar'}))`, `result` will be `{foo: 'bar'}`. Otherwise `stdout` carries the raw text.

### Example

```javascript
const { Browser } = require('@testmuai/browser-cloud');

(async () => {
  const client = new Browser();
  const session = await client.sessions.create({
    adapter: 'playwright',
    lambdatestOptions: {
      build: 'n8n-browsercloud',
      name: 'demo',
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
})();
```

This script is portable: the same code runs unchanged on your laptop (`node script.js`) and inside the n8n node.

---

## Node: Browsercloud Agent

A single tool the n8n AI Agent calls to drive a cloud browser. One node, multiple actions — the AI picks which action to run per call:

- **`navigate`** — open a URL
- **`snapshot`** — get a numbered list of clickable / fillable elements on the current page
- **`click`** — click an element by ref number from the latest snapshot
- **`type`** — type into an input by ref number
- **`get_text`** — read text from a specific element or the whole page
- **`screenshot`** — capture base64 PNG (for vision-capable models)

After every action, the response back to the AI includes a fresh snapshot of the page — so the agent doesn't need to call `snapshot` separately between every click and type.

### How to wire it up in n8n

```
[Trigger] → [AI Agent]
              ↑ Tools (sub-input on the bottom of the Agent node)
              [Browsercloud Agent]
              ↑ Chat Model
              [Gemini / Claude / OpenAI Chat Model]
```

1. Add an **AI Agent** node.
2. Wire a **Chat Model** sub-node into the Agent's Chat Model socket. Pick any tool-calling-capable model (Gemini 2.5 Flash, GPT-4o, Claude Sonnet, etc.).
3. Wire **Browsercloud Agent** into the Agent's **Tools** socket.
4. Pick the **Browsercloud (TestMu AI) API** credential on the Browsercloud Agent node.
5. Set the Agent's system message (see below) and your user message ("test 50 hotels on airbnb.com from May 1 to May 5").
6. Run.

### Suggested system message

```
You drive a real cloud browser via the Browsercloud Agent tool. Steps:

1. Call navigate first to open the right URL.
2. Click and type refer to elements by their ref number from the latest snapshot.
   Every tool response includes a fresh snapshot — use it.
3. After any state change, refresh by calling snapshot if the agent's response
   doesn't include one you trust.
4. If an element's role contains "(readonly)", do NOT try to type into it.
   Click it instead — it usually opens a picker with a real input you can type into.
5. Use get_text to extract content. Stop when the goal is achieved.

Never refer to refs from previous turns — refs are only valid against the latest snapshot.
```

### Node configuration

- **Browser** — Chrome / Microsoft Edge / Playwright Chromium / Playwright Firefox / Playwright WebKit (Safari-like). See "Browser names" below.
- **Platform** — Windows 11 / Windows 10 / macOS Sequoia / Sonoma / Ventura / Monterey / Linux.
- **Browser Version** — Latest / Latest - 1 / Latest - 2 / Latest - 3 / Beta / Dev.
- **Session Scope** — `Per Workflow Execution (Shared)` (default; one browser shared across all AI tool calls in one workflow run) or `Per Tool Call (New Each Time)` (fresh browser per call; agent loses navigation state — not recommended for AI use).
- **Action** — filled automatically by the AI; not set manually.
- **URL / Ref / Text / Submit / Max Text Length / Full Page Screenshot** — filled automatically by the AI based on the action.

### Browser names (the `pw-*` thing)

The Browsercloud Agent uses Playwright internally to talk to the cloud browser. Playwright can't drive every real-world browser directly, so the browser list reflects what Playwright actually supports:

| You want | Pick this | Notes |
|---|---|---|
| Real Chrome | **Chrome** | Native Chrome over CDP. |
| Real Edge | **Microsoft Edge** | Native Edge over CDP. |
| Firefox-ish | **Playwright Firefox** | Playwright's bundled Firefox build. Same engine as Mozilla Firefox, different binary. |
| Safari-ish | **Playwright WebKit (Safari-like)** | Playwright's bundled WebKit. Same engine as Safari, but **not** Apple's Safari. |
| Generic Chromium | **Playwright Chromium** | Playwright's bundled Chromium. |

**Real Safari** is not available with this node — Apple doesn't allow remote control of Safari over Playwright. For most tests, WebKit (`pw-webkit`) is a faithful enough substitute. If you absolutely need real Safari, use the **Browsercloud** script-runner with the Selenium adapter.

### Session lifecycle and limits

- **One cloud session per workflow execution** — provisioned on the first tool call, reused across all subsequent calls within the same run.
- **Sessions are released automatically** after ~60 seconds of inactivity (the session manager's idle reaper).
- **Browser/Platform/Version are locked in at session creation** — picked from the dropdowns on the first tool call. Changing them mid-workflow has no effect; the session is persistent.
- **Visible on the LambdaTest dashboard** — every session shows up under the build name `n8n-browsercloud` with the workflow name + timestamp as the session name.

### Snapshot behavior

When the agent calls `snapshot` (or after any action), the node returns a numbered list of interactive elements:

```
1. <button> [button] Search
2. <input> [input] Email
3. <input> [input (readonly)] Goa
4. <a> [link] Sign in
...
```

Snapshot filtering:

- Excludes elements that are disabled, `aria-hidden`, `aria-disabled`, `type="hidden"`, or covered by an overlay/modal (`document.elementFromPoint` mismatch).
- **Keeps** readonly inputs but tags them `(readonly)`. They're common entry points for date pickers / autocomplete popups — the agent should click them to open the picker, not try to type into them.

### Click and type error recovery

- **Click** retries once with `{ force: true }` if a popup, banner, or modal is briefly covering the target — clicks through it instead of timing out at 30 seconds.
- **Type** fails fast (10s timeout instead of 30s) with a clear error if the agent picks a disabled or readonly input.

---

## Architectural notes

- **Browsercloud (script-runner)** spawns scripts in a **child Node.js process**. Crashes are contained; `process.env` is isolated per execution.
- **Browsercloud Agent** runs in-process and manages a persistent Playwright connection. It mutates `process.env.LT_USERNAME` and `process.env.LT_ACCESS_KEY` because the TestMu SDK reads from those at construction time.
- **Concurrent session creation** is deduplicated via an in-flight `Promise` map, so parallel tool calls from the agent don't each provision their own session.

## Limitations

- **Only Playwright adapter for the Agent node.** Switching to Selenium or Puppeteer would require rewriting every action handler. The script-runner node has no such limit.
- **No real Safari** via the Agent node (Playwright limitation; use the script-runner with Selenium for real Safari).
- **No vision-based clicking** — the agent picks elements by ref number from the snapshot, not by looking at a screenshot. Screenshot is available as a separate action for vision-capable models that want it.
- **Self-hosted n8n only** — community nodes don't run on n8n Cloud unless verified by n8n's review program.

## License

MIT
