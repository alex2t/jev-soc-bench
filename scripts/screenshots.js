/**
 * npm run screenshots [-- --out=<dir>]: capture README images of the local preview into docs/img/.
 * Starts the read-only preview server in-process on a free port, opens the page in Playwright's
 * Chromium, and fails on a console error, a page error or any request that leaves 127.0.0.1.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { previewServer } from '../server.js';

/** README image name -> the element holding that section. */
const SHOTS = {
  'headline.png': '#cards',
  'difficulty.png': 'section:has(#difficulty)',
  'latency.png': 'section:has(#latency)',
  'automation.png': 'section:has(#automation)',
};

async function capture(baseUrl, outDir) {
  const browser = await chromium.launch();
  const problems = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
    page.on('console', msg => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });
    page.on('pageerror', err => problems.push(`page error: ${err.message}`));
    page.on('request', req => { if (!req.url().startsWith(baseUrl)) problems.push(`external request: ${req.url()}`); });
    await page.goto(baseUrl);
    await page.locator('#main').waitFor({ state: 'visible' });
    if ((await page.locator('body').innerText()).includes('[object ')) problems.push('page shows "[object ...]": a list was appended as text');
    for (const [name, selector] of Object.entries(SHOTS)) {
      await page.locator(selector).screenshot({ path: join(outDir, name) });
    }
  } finally {
    await browser.close();
  }
  if (problems.length) throw new Error(problems.join('\n'));
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'docs/img' } } });
  mkdirSync(values.out, { recursive: true });
  const server = previewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await capture(`http://127.0.0.1:${server.address().port}/`, values.out);
    console.log(`Wrote ${Object.keys(SHOTS).join(', ')} to ${values.out}`);
  } finally {
    server.close();
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
