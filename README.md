# n8n-nodes-browsercloud

An n8n community node that runs browser automation scripts on [TestMu AI Browser Cloud](https://www.testmuai.com/browser-cloud/) (formerly LambdaTest).

The node is **framework-agnostic**: write your script in Playwright, Puppeteer, Selenium, WebdriverIO, or anything else that can connect to a remote browser. The node provides the cloud session; your script does whatever it wants with it.

## Install

In your n8n instance:

```
npm install n8n-nodes-browsercloud
```

Then install whichever browser automation framework your scripts will use:

```
npm install playwright          # for Playwright scripts
npm install puppeteer-core      # for Puppeteer scripts
npm install selenium-webdriver  # for Selenium scripts
npm install webdriverio         # for WebdriverIO scripts
```

If you self-host n8n, set this env var so user scripts can `require()` those frameworks:

```
NODE_FUNCTION_ALLOW_EXTERNAL=playwright,puppeteer-core,selenium-webdriver,webdriverio
```

Restart n8n. Done.

## Credentials

Add a "Browsercloud (TestMu AI) API" credential with your TestMu username and access key (find them in your account profile).

## Usage

Drop a Browsercloud node anywhere in a workflow. Paste your script in the Script field. The node will:

1. Open a TestMu Browser Cloud session
2. Run your script with these globals already injected:
   - `wsEndpoint` — CDP WebSocket URL of a fresh cloud browser
   - `credentials` — `{ username, accessKey }`
   - `item` — the current n8n input item
   - `$input`, `$json` — the current item's JSON
   - `console` — logs are returned on the output
3. Whatever you assign to `result` becomes the node output
4. Close the session and attach the session ID so you can debug on the TestMu dashboard

### Example: Playwright

```javascript
const { chromium } = require('playwright');
const browser = await chromium.connectOverCDP(wsEndpoint);
try {
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();
  await page.goto(item.json.url);
  await page.fill('#destination', item.json.destination);
  await page.click('button[type=submit]');
  await page.waitForSelector('.hotel-card');
  result = await page.$$eval('.hotel-card h3', els => els.map(e => e.textContent));
} finally {
  await browser.close();
}
```

### Example: Puppeteer

```javascript
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
try {
  const page = await browser.newPage();
  await page.goto(item.json.url);
  result = { title: await page.title() };
} finally {
  await browser.close();
}
```

### Example: Selenium

```javascript
const { Builder } = require('selenium-webdriver');
const driver = await new Builder()
  .usingServer(`https://${credentials.username}:${credentials.accessKey}@hub.lambdatest.com/wd/hub`)
  .withCapabilities({ browserName: 'chrome', 'LT:Options': { build: 'n8n-run' } })
  .build();
try {
  await driver.get(item.json.url);
  result = { title: await driver.getTitle() };
} finally {
  await driver.quit();
}
```

## Session modes

- **New session per item** (default) — fresh browser for every input item. Safer, slower.
- **Reuse session for run** — one browser shared across all items in this run. Faster, but cookies and login state carry over.

## Output

```json
{
  "result": <whatever your script returned>,
  "sessionId": "abc-123",
  "sessionUrl": "https://automation.lambdatest.com/test?testID=abc-123",
  "durationMs": 4280,
  "logs": ["console.log lines from your script"]
}
```

Visit `sessionUrl` to see the full video, network log, and console replay on the TestMu dashboard.

## License

MIT
