import { MAX_BYTES } from './contract.ts';

export async function openWorkspace(text?: string, hash = '', source = '', browser = chrome): Promise<void> {
  const tab = await browser.tabs.create({ url: browser.runtime.getURL('workspace.html'), active: !text });
  if (!text) return;
  if (tab.id === undefined) throw new Error('Workspace tab unavailable. Retry extraction.');
  const id = tab.id;
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let sending = false;
    let retry = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
      if (error) reject(error); else resolve();
    };
    const transfer = async () => {
      if (finished) return;
      if (sending) { retry = true; return; }
      sending = true;
      try {
        const reply = await browser.runtime.sendMessage({ type: 'import-spec', targetTab: id, text, hash, source });
        if (finished) return;
        if (reply?.received === true) {
          try { await browser.tabs.update(id, { active: true }); finish(); }
          catch { finish(new Error('Workspace received specification but could not activate its tab. Open workspace tab manually.')); }
        } else if (reply?.received === false) finish(new Error('Specification import failed. Review workspace for details.'));
      } catch { /* Workspace may still be loading; retry when its tab is ready. */ }
      finally {
        sending = false;
        if (retry && !finished) { retry = false; void transfer(); }
      }
    };
    const listener = (tabId: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (tabId === id && info.status === 'complete') void transfer();
    };
    const timer = setTimeout(() => finish(new Error('Workspace transfer failed. Retry extraction; keep popup open while loading.')), 8000);
    browser.tabs.onUpdated.addListener(listener);
    void transfer();
  });
}

export async function receiveWorkspace(load: (text: string, hash: string, source: string) => void, onError: (error: unknown) => void, browser = chrome): Promise<() => void> {
  const tab = await browser.tabs.getCurrent();
  const listener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (reply: { received: boolean }) => void) => {
    if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL('popup.html')) return;
    if (!message || typeof message !== 'object') return;
    const input = message as Record<string, unknown>;
    if (tab?.id === undefined || input.type !== 'import-spec' || input.targetTab !== tab.id) return;
    if (typeof input.text !== 'string' || input.text.length > MAX_BYTES || typeof input.hash !== 'string' || input.hash.length > 8192) return;
    try {
      load(input.text, input.hash, typeof input.source === 'string' ? input.source.slice(0, 100) : 'Swagger');
      respond({ received: true });
    } catch (error) {
      onError(error);
      respond({ received: false });
    }
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}
