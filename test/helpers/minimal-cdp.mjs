// A minimal Chrome DevTools Protocol client, hand-rolled with node's builtin
// fetch + WebSocket so the employee test suite needs no network install
// (puppeteer/playwright are not present on this machine and installing them
// would call an external registry, which the session rails forbid). Launches
// local Chrome headless against ONLY the local mock server — never a live
// Raydar page.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findChrome() {
  return CHROME_PATHS.find(p => fs.existsSync(p)) || null;
}

export async function launchChrome({ headless = true } = {}) {
  const chromePath = findChrome();
  if (!chromePath) return null;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-employee-cdp-'));
  const port = 9000 + Math.floor(Math.random() * 900);
  const args = [
    headless ? '--headless=new' : '',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1440,900',
  ].filter(Boolean);
  const child = spawn(chromePath, args, { stdio: 'ignore' });
  // Wait for the DevTools HTTP endpoint to come up.
  const deadline = Date.now() + 10000;
  let version = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) { version = await response.json(); break; }
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  if (!version) { child.kill(); return null; }
  return { child, port, userDataDir, wsUrl: version.webSocketDebuggerUrl };
}

export async function closeChrome(chrome) {
  if (!chrome) return;
  try { chrome.child.kill(); } catch {}
  try { fs.rmSync(chrome.userDataDir, { recursive: true, force: true }); } catch {}
}

// One CDP session over one WebSocket to the browser endpoint, then attached
// to a single new page target. Enough surface for this suite: navigate,
// evaluate, screenshot-free DOM reads, viewport resize, and event waiting.
export class CDPPage {
  constructor(ws, sessionId, targetId) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleMessages = [];
    ws.addEventListener('message', event => this._onMessage(JSON.parse(event.data)));
  }

  _onMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.sessionId === this.sessionId) {
      this.consoleMessages.push({ type: message.params.type, text: (message.params.args || []).map(a => a.value ?? a.description ?? '').join(' ') });
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = { id, method, params, sessionId: this.sessionId };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async navigate(url) {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    const nav = await this.send('Page.navigate', { url });
    await this._waitForLoad();
    return nav;
  }

  _waitForLoad() {
    return new Promise(resolve => {
      const handler = event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Page.loadEventFired' && message.sessionId === this.sessionId) {
          this.ws.removeEventListener('message', handler);
          resolve();
        }
      };
      this.ws.addEventListener('message', handler);
      setTimeout(resolve, 8000); // safety timeout
    });
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 768,
    });
  }

  async waitFor(predicateJs, { timeout = 5000, interval = 100 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ok = await this.evaluate(predicateJs).catch(() => false);
      if (ok) return true;
      await new Promise(r => setTimeout(r, interval));
    }
    return false;
  }
}

export async function openPage(chrome) {
  const browserWs = new WebSocket(chrome.wsUrl);
  await new Promise((resolve, reject) => {
    browserWs.addEventListener('open', resolve, { once: true });
    browserWs.addEventListener('error', reject, { once: true });
  });
  const target = await sendOnce(browserWs, 'Target.createTarget', { url: 'about:blank' });
  const attach = await sendOnce(browserWs, 'Target.attachToTarget', { targetId: target.targetId, flatten: true });
  return new CDPPage(browserWs, attach.sessionId, target.targetId);
}

function sendOnce(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const handler = event => {
      const message = JSON.parse(event.data);
      if (message.id === id) {
        ws.removeEventListener('message', handler);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
