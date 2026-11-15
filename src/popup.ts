import { inspectSwagger } from './discover.ts';
import { openWorkspace } from './delivery.ts';
import './style.css';

const status = document.querySelector<HTMLElement>('#status')!;
const extractButton = document.querySelector<HTMLButtonElement>('#extract')!;
const candidates = document.querySelector<HTMLUListElement>('#candidates')!;

async function capture(explicitUrl?: string): Promise<void> {
  extractButton.disabled = true;
  status.textContent = 'Reading Swagger documentation…';
  candidates.replaceChildren();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) throw new Error('Open a Swagger HTTP(S) page, then click extension again.');
    if (explicitUrl) {
      const requested = new URL(explicitUrl);
      const current = new URL(tab.url);
      if (requested.origin !== current.origin || requested.username || requested.password || requested.hash) throw new Error('Use a specification URL on current Swagger origin, without credentials or fragment.');
    }
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: inspectSwagger, args: explicitUrl ? [explicitUrl] : [] });
    const result = results[0]?.result;
    if (!result) throw new Error('Swagger page returned no data. Import a saved specification.');
    for (const url of result.candidates) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = url;
      button.addEventListener('click', () => void capture(url));
      li.append(button); candidates.append(li);
    }
    if (!result.text) throw new Error(result.error ?? 'Specification not found.');
    status.textContent = 'Opening local preview… Keep popup open until it loads.';
    await openWorkspace(result.text, result.hash, result.source);
    window.close();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Extraction failed. Import JSON/YAML instead.';
  } finally { extractButton.disabled = false; }
}

extractButton.addEventListener('click', () => void capture());
document.querySelector('#import')!.addEventListener('click', () => {
  void openWorkspace().catch(error => { status.textContent = error instanceof Error ? error.message : 'Could not open workspace.'; });
});
