import { extract, matchFragment, operations, parseSpec, MAX_BYTES, type Contract, type ObjectValue, type Operation } from './contract.ts';
import { documentation, exportContract, type ExportOptions } from './documentation.ts';
import { receiveWorkspace } from './delivery.ts';
import './style.css';

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = get('status');
const search = get<HTMLInputElement>('search');
let documentValue: ObjectValue | undefined;
let items: Operation[] = [];
let selected: Contract | undefined;
let importGeneration = 0;
const mode = get<HTMLSelectElement>('export-mode');
const generatedExamples = get<HTMLInputElement>('generated-examples');
const options = (): ExportOptions => ({ raw: mode.value === 'raw', generatedExamples: generatedExamples.checked });

const picker = get<HTMLDetailsElement>('endpoint-picker');
const mobile = window.matchMedia('(max-width: 800px)');
const header = document.querySelector<HTMLElement>('.topbar')!;
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--header-height', `${header.getBoundingClientRect().height}px`);
}).observe(header);
picker.querySelector('summary')!.addEventListener('click', event => {
  if (!mobile.matches) event.preventDefault();
});
mobile.addEventListener('change', () => { picker.open = !mobile.matches || !selected; });

function show(operation: Operation, navigate = true): void {
  if (!documentValue) return;
  try {
    const contract = extract(documentValue, operation);
    selected = contract;
    get('empty').hidden = true;
    get('preview').hidden = false;
    get('method').textContent = operation.method;
    get('path').textContent = operation.path;
    get('summary').textContent = operation.summary || 'No summary provided.';
    generatedExamples.disabled = mode.value === 'raw';
    const warnings = contract.warnings;
    get('warnings').replaceChildren(...warnings.map(warning => {
      const li = document.createElement('li'); li.textContent = warning; return li;
    }));
    const blocks = documentation(contract, options());
    get('sections').replaceChildren(...blocks.map(block => {
      const section = document.createElement('section'); section.className = 'contract-section';
      const heading = document.createElement('h3'); heading.textContent = block.heading;
      section.append(heading);
      if ('text' in block && block.text) {
        const text = document.createElement('p'); text.className = 'documentation-text'; text.textContent = block.text; section.append(text);
      }
      if ('columns' in block && block.columns) {
        const wrapper = document.createElement('div'); wrapper.className = 'table-scroll'; wrapper.tabIndex = 0;
        wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', block.heading);
        const table = document.createElement('table');
        const head = table.createTHead().insertRow();
        for (const label of block.columns) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; head.append(th); }
        const body = table.createTBody();
        for (const row of block.rows ?? []) { const tr = body.insertRow(); for (const value of row) { const td = tr.insertCell(); td.textContent = value; } }
        wrapper.append(table); section.append(wrapper);
      }
      if (block.json !== undefined) {
        const pre = document.createElement('pre'); pre.textContent = JSON.stringify(block.json, null, 2); pre.tabIndex = 0;
        pre.setAttribute('aria-label', block.heading); section.append(pre);
      }
      return section;
    }));
    for (const button of document.querySelectorAll<HTMLButtonElement>('#endpoints button')) {
      button.setAttribute('aria-current', String(button.dataset.key === `${operation.method} ${operation.path}`));
    }
    document.title = `${contract.title} — Swagger Exporter`;
    status.textContent = 'Contract ready. Review warnings and examples before sharing.';
    if (navigate) {
      picker.open = !mobile.matches;
      if (mobile.matches) get('path').focus({ preventScroll: true });
      requestAnimationFrame(() => {
        get('preview').scrollIntoView({ block: 'start', behavior: 'instant' });
        if (!mobile.matches) {
          const list = get('endpoints');
          const active = list.querySelector<HTMLElement>('[aria-current="true"]');
          if (active) {
            const bounds = list.getBoundingClientRect();
            const item = active.getBoundingClientRect();
            if (item.top < bounds.top) list.scrollTop += item.top - bounds.top;
            else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
          }
        }
      });
    }
  } catch (error) { status.textContent = error instanceof Error ? error.message : 'Could not extract endpoint.'; }
}

function renderList(): void {
  const query = search.value.toLowerCase().trim();
  const matches = items.filter(item => `${item.method} ${item.path} ${item.id} ${item.summary} ${item.tags.join(' ')}`.toLowerCase().includes(query));
  get('count').textContent = `${matches.length}`;
  // ponytail: render first 300 matches; narrow search before adding list virtualization.
  get('endpoints').replaceChildren(...matches.slice(0, 300).map(item => {
    const button = document.createElement('button'); button.className = 'endpoint';
    button.dataset.key = `${item.method} ${item.path}`;
    button.setAttribute('aria-current', String(selected?.operation === item));
    const method = document.createElement('span'); method.className = 'method'; method.textContent = item.method;
    const path = document.createElement('span'); path.textContent = item.path;
    button.append(method, path); button.addEventListener('click', () => show(item)); return button;
  }));
  if (!matches.length || matches.length > 300) {
    const note = document.createElement('p'); note.className = 'list-note';
    note.textContent = matches.length ? 'Showing first 300 matches. Narrow search for more.' : 'No endpoints match your search.';
    get('endpoints').append(note);
  }
}

function load(text: string, hash: string, source: string): void {
  const next = parseSpec(text);
  const nextItems = operations(next);
  if (!nextItems.length) throw new Error('No supported endpoints found in specification.');
  documentValue = next;
  items = nextItems;
  selected = undefined;
  search.value = '';
  picker.open = true;
  get('endpoints').scrollTop = 0;
  get('empty').hidden = false;
  get('preview').hidden = true;
  get('sections').replaceChildren();
  renderList();
  const match = matchFragment(items, hash);
  if (match) show(match);
  else status.textContent = `${source || 'Specification'} loaded: ${items.length} endpoints. ${hash ? 'Link did not identify one endpoint reliably. ' : ''}Select an endpoint to preview.`;
}

get<HTMLInputElement>('file').addEventListener('change', async event => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  const generation = ++importGeneration;
  if (!file) return;
  try {
    if (file.size > MAX_BYTES) throw new Error('Specification exceeds 10 MB limit.');
    const text = await file.text();
    if (generation === importGeneration) load(text, '', 'Imported file');
  } catch (error) { if (generation === importGeneration) status.textContent = error instanceof Error ? error.message : 'File import failed.'; }
  finally { input.value = ''; }
});
search.addEventListener('input', renderList);
mode.addEventListener('change', () => { if (selected) show(selected.operation, false); });
generatedExamples.addEventListener('change', () => { if (selected) show(selected.operation, false); });

get('copy').addEventListener('click', async () => {
  if (!selected) return;
  try { await navigator.clipboard.writeText(exportContract(selected, options())); status.textContent = 'Markdown copied.'; }
  catch { status.textContent = 'Clipboard access denied. Check browser clipboard permissions, then retry Copy Markdown.'; }
});

// Vite preview also works for local file imports, without extension APIs.
if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  await receiveWorkspace(load, error => {
    status.textContent = error instanceof Error ? error.message : 'Specification import failed.';
  });
}
