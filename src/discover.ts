// Runs in the page's MAIN world. Keep self-contained; all returned data is untrusted.
export async function inspectSwagger(explicitUrl?: string): Promise<{ text?: string; hash: string; source?: string; candidates: string[]; error?: string }> {
  const limit = 10 * 1024 * 1024;
  const candidates = new Set<string>();
  const result = { hash: location.hash, candidates: [] as string[] };
  function add(raw: unknown): void {
    if (typeof raw !== 'string' || raw.length > 4096) return;
    try {
      const url = new URL(raw, location.href);
      if (url.origin === location.origin && /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.hash) candidates.add(url.href);
    } catch { /* Not a URL. */ }
  }
  const page = window as unknown as { ui?: { specSelectors?: { specJson?: () => { toJS?: () => unknown } }; getConfigs?: () => Record<string, unknown> } };
  if (!explicitUrl) {
    try {
      const spec = page.ui?.specSelectors?.specJson?.().toJS?.();
      if (spec && typeof spec === 'object' && ('openapi' in spec || 'swagger' in spec)) {
        const text = JSON.stringify(spec);
        if (new TextEncoder().encode(text).length <= limit) return { ...result, text, source: 'Loaded Swagger specification' };
      }
      const config = page.ui?.getConfigs?.();
      add(config?.url);
      if (Array.isArray(config?.urls)) config.urls.slice(0, 20).forEach(entry => add(entry?.url));
    } catch { /* Continue with non-executable configuration inspection. */ }
    for (const script of Array.from(document.scripts).slice(0, 100)) {
      const content = (script.textContent ?? '').slice(0, 500_000);
      if (script.type === 'application/json') {
        try { const config = JSON.parse(content); add(config.url); add(config.specUrl); } catch { /* Not Swagger configuration. */ }
      }
      for (const match of content.matchAll(/(?:["']?(?:url|spec-url|specUrl)["']?)\s*[:=]\s*["']([^"'\s]+)["']/g)) add(match[1]);
    }
    for (const link of Array.from(document.querySelectorAll('[spec-url], a[href], link[href]')).slice(0, 500)) {
      add(link.getAttribute('spec-url'));
      const href = link.getAttribute('href');
      if (href && /(?:openapi|swagger|schema).*(?:json|ya?ml)|\?format=(?:openapi|json)/i.test(href)) add(href);
    }
  } else {
    add(explicitUrl);
    if (!candidates.size) return { ...result, error: 'Use a same-origin HTTP(S) specification URL without credentials or fragment.' };
  }
  result.candidates = [...candidates].slice(0, 20);
  // ponytail: no endpoint guessing or cross-origin discovery; add approved origins after real backend testing.
  if (result.candidates.length !== 1) return { ...result, error: result.candidates.length ? 'Multiple specification URLs found. Choose one below.' : 'Specification not discovered. Wait for Swagger to finish loading and retry, or import JSON/YAML.' };
  const url = result.candidates[0];
  try {
    const response = await fetch(url, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json, application/yaml, text/yaml, */*' } });
    if (!response.ok) return { ...result, error: response.status === 401 || response.status === 403 ? `Documentation access denied (${response.status}). Open specification URL in this browser, sign in, then retry; or import a saved file.` : `Specification request failed (${response.status}).` };
    if (Number(response.headers.get('content-length')) > limit) throw new Error('Specification exceeds 10 MB limit.');
    if (!response.body) throw new Error('Specification response is empty.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw new Error('Specification exceeds 10 MB limit.');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel(); }
    return { ...result, text, source: 'Authenticated Swagger tab' };
  } catch (error) {
    return { ...result, error: error instanceof Error && error.message.includes('10 MB') ? error.message : 'Browser could not retrieve specification. Check login, same-origin URL, redirects, and network access; or import JSON/YAML.' };
  }
}
