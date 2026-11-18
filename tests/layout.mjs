import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.includes('..')) throw new Error('Invalid path');
    response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] ?? 'application/octet-stream');
    response.end(await readFile(join(root, path)));
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(join(tmpdir(), 'swagger-layout-'));
const browser = spawn(process.env.CHROME_BIN ?? 'google-chrome', ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
const timeout = setTimeout(() => { console.error('Browser check timed out.'); browser.kill('SIGTERM'); }, 30000);
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    browser.on('error', reject);
    browser.on('exit', code => reject(new Error(`Chrome exited ${code}: ${output}`)));
    browser.stderr.on('data', data => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
  });
  const base = endpoint.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '');
  const targets = await fetch(`${base}/json/list`).then(response => response.json());
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id) { const handler = pending.get(data.id); pending.delete(data.id); data.error ? handler.reject(data.error) : handler.resolve(data.result); }
    else if (data.method === 'Runtime.exceptionThrown') exceptions.push(data);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const frame = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const loaded = new Promise(resolve => {
    const listener = event => { if (JSON.parse(event.data).method === 'Page.loadEventFired') { socket.removeEventListener('message', listener); resolve(); } };
    socket.addEventListener('message', listener);
  });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/workspace.html` });
  await loaded;
  const fixture = { openapi: '3.1.0', info: { title: 'Layout check', version: '1' }, paths: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`/products/${index}`, { get: { summary: 'Product', responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'integer' } } }, example: Array.from({ length: 100 }, (_, id) => ({ id })) } } } } } }])) };
  await evaluate(`(async () => {
    const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(JSON.stringify(fixture))}], 'layout.json'));
    const file = document.getElementById('file'); file.files = transfer.files; file.dispatchEvent(new Event('change'));
    for (let n = 0; n < 100 && !document.querySelector('.endpoint'); n++) await new Promise(resolve => setTimeout(resolve, 10));
    document.querySelector('.endpoint').click();
  })()`);
  await frame();
  await evaluate('window.scrollTo(0, 1200)');
  await frame();
  const desktop = await evaluate(`(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
    const list = document.getElementById('endpoints');
    return { header: rect('.topbar'), rail: rect('.rail'), search: rect('#search'), list: rect('#endpoints'), toolbar: rect('.toolbar'), listScrollable: list.scrollHeight > list.clientHeight, preMax: getComputedStyle(document.querySelector('pre')).maxHeight, scroll: scrollY };
  })()`);
  assert.ok(desktop.scroll > 500);
  assert.ok(Math.abs(desktop.header.top) < 1);
  assert.ok(Math.abs(desktop.rail.top - desktop.header.bottom) < 1);
  assert.ok(desktop.search.top >= desktop.header.bottom);
  assert.ok(desktop.list.bottom <= 801, JSON.stringify(desktop));
  assert.ok(desktop.listScrollable);
  assert.ok(Math.abs(desktop.toolbar.top - desktop.header.bottom) < 1);
  assert.equal(desktop.preMax, 'none');
  const before = await evaluate(`(() => { const list = document.getElementById('endpoints'); const button = list.children[25]; list.scrollTop = button.offsetTop - list.offsetTop; return list.scrollTop; })()`);
  await evaluate("document.getElementById('endpoints').children[25].click()");
  await frame();
  const after = await evaluate(`({ list: document.getElementById('endpoints').scrollTop, heading: document.getElementById('path').textContent, preview: document.getElementById('preview').getBoundingClientRect().top, header: document.querySelector('.topbar').getBoundingClientRect().bottom })`);
  assert.equal(after.heading, '/products/25');
  assert.ok(Math.abs(after.list - before) < 1, 'Endpoint selection reset sidebar position');
  assert.ok(after.preview >= after.header);
  await evaluate('window.scrollTo(0, 1000); document.getElementById("export-mode").value = "raw"; document.getElementById("export-mode").dispatchEvent(new Event("change"))');
  await frame();
  assert.ok(await evaluate('scrollY > 500'), 'Changing export options jumped to heading');
  const split = await evaluate(`(() => { const r = document.getElementById('splitter').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 200, document: document.querySelector('.document').getBoundingClientRect().width }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: split.x, y: split.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: split.x + 100, y: split.y, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: split.x + 100, y: split.y, button: 'left', clickCount: 1 });
  await frame();
  assert.equal(await evaluate('document.querySelector(".rail").getBoundingClientRect().width'), 420);
  assert.equal(await evaluate('document.querySelector(".document").getBoundingClientRect().width'), split.document - 100);
  assert.equal(await evaluate('document.getElementById("splitter").getAttribute("aria-valuenow")'), '420');
  assert.equal(await evaluate('document.body.classList.contains("resizing")'), false);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft' });
  assert.equal(await evaluate('document.querySelector(".rail").getBoundingClientRect().width'), 410);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' });
  const edge = await evaluate(`({ sidebar: document.querySelector('.rail').getBoundingClientRect().width, available: document.querySelector('.workspace').clientWidth, document: document.querySelector('.document').getBoundingClientRect().width })`);
  assert.equal(edge.sidebar, edge.available - 10);
  assert.equal(edge.document, 0);
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
  await frame();
  const narrow = await evaluate(`({ width: document.querySelector('.rail').getBoundingClientRect().width, max: Number(document.getElementById('splitter').getAttribute('aria-valuemax')), available: document.querySelector('.workspace').clientWidth, document: document.querySelector('.document').getBoundingClientRect().width })`);
  assert.equal(narrow.width, narrow.available - 10);
  assert.equal(narrow.max, narrow.width);
  assert.equal(narrow.document, 0);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home' });
  assert.equal(await evaluate('document.querySelector(".rail").getBoundingClientRect().width'), 0);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Collapsed pane caused horizontal overflow');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
  assert.equal(await evaluate('document.querySelector(".rail").getBoundingClientRect().width'), 10);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await frame();
  assert.equal(await evaluate('document.getElementById("endpoint-picker").open'), false);
  assert.equal(await evaluate('getComputedStyle(document.getElementById("splitter")).display'), 'none');
  await evaluate('document.querySelector("#endpoint-picker summary").click()');
  assert.equal(await evaluate('document.getElementById("endpoint-picker").open'), true);
  await evaluate('document.getElementById("endpoints").children[1].click()');
  await frame();
  const mobile = await evaluate(`({ open: document.getElementById('endpoint-picker').open, focus: document.activeElement.id, width: document.documentElement.scrollWidth, viewport: innerWidth })`);
  assert.equal(mobile.open, false);
  assert.equal(mobile.focus, 'path');
  assert.ok(mobile.width <= mobile.viewport);
  const controls = await evaluate(`({ buttons: [...document.querySelectorAll('.toolbar button')].map(button => button.id), generated: document.getElementById('generated-examples').checked })`);
  assert.deepEqual(controls.buttons, ['copy']);
  assert.equal(controls.generated, true);
  await send('Page.bringToFront');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Browser.grantPermissions', { origin: `http://127.0.0.1:${server.address().port}`, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  for (const mode of ['raw', 'readable']) {
    await evaluate(`document.getElementById('export-mode').value = ${JSON.stringify(mode)}; document.getElementById('export-mode').dispatchEvent(new Event('change')); document.getElementById('copy').click()`);
    const copied = await evaluate(`(async () => { for (let n = 0; n < 100; n++) { if (document.getElementById('status').textContent === 'Markdown copied.') return navigator.clipboard.readText(); await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(document.getElementById('status').textContent); })()`);
    assert.ok(copied.startsWith('# GET /products/1'));
    const headings = await evaluate(`[...document.querySelectorAll('#sections h3')].map(heading => heading.textContent)`);
    assert.deepEqual(copied.split('\n').filter(line => line.startsWith('## ')), headings.map(heading => `## ${heading}`));
    assert.ok(copied.includes(mode === 'raw' ? '## references' : 'backend-provided'));
  }
  for (const theme of ['dark', 'light']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    const colors = await evaluate(`(() => {
      const selectors = [':root', '.document', '.topbar', '.toolbar', '#search', '#export-mode', '.endpoint[aria-current="true"]', '.method', '.warnings', 'pre', 'th'];
      return selectors.map(selector => {
        const style = getComputedStyle(document.querySelector(selector));
        return { selector, text: style.color, background: style.backgroundColor };
      });
    })()`);
    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(value => {
      const n = Number(value) / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
    for (const color of colors) {
      const a = luminance(color.text), b = luminance(color.background);
      assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, `${theme} contrast: ${color.selector}`);
    }
    assert.equal(colors[0].background, theme === 'dark' ? 'rgb(21, 35, 48)' : 'rgb(237, 243, 249)');
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), `${theme} horizontal overflow`);
  }
  const popup = await readFile(join(root, 'popup.html'), 'utf8');
  assert.ok(!popup.includes('spec-url') && !popup.includes('manual-form'));
  assert.ok(popup.includes('id="extract"') && popup.includes('id="import"') && popup.includes('id="candidates"'));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  const popupLoaded = new Promise(resolve => {
    const listener = event => { if (JSON.parse(event.data).method === 'Page.loadEventFired') { socket.removeEventListener('message', listener); resolve(); } };
    socket.addEventListener('message', listener);
  });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/popup.html` });
  await popupLoaded;
  const popupTheme = await evaluate(`(async () => {
    for (let n = 0; n < 100; n++) {
      if (document.querySelector('#extract') && getComputedStyle(document.documentElement).backgroundColor === 'rgb(21, 35, 48)') {
        const style = getComputedStyle(document.getElementById('extract'));
        return { background: style.backgroundColor, text: style.color };
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Popup dark theme did not load');
  })()`);
  assert.deepEqual(popupTheme, { background: 'rgb(105, 197, 200)', text: 'rgb(16, 39, 45)' });
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('Layout check passed: sticky sidebar/search/toolbar, independent list, heading navigation, retained sidebar position, stable export options, mobile picker/focus, copy-only Markdown, generated-examples default, light/dark contrast, dark popup, pointer/keyboard resizing and width limits.');
} finally {
  clearTimeout(timeout);
  socket?.close();
  const exited = new Promise(resolve => browser.once('exit', resolve));
  if (browser.exitCode === null) { browser.kill('SIGTERM'); await exited; }
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
