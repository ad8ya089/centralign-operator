import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { ToolFault } from '../tools/errors.js';

interface Session { id: string; owner: string; context: BrowserContext; page: Page; finalUrl: string }
export interface BrowserSnapshot { sessionId: string; url: string; title: string; text: string; headings: string[]; links: { text: string; href: string }[] }

export class RestrictedBrowser {
  private browser: Browser | undefined;
  private launch: Promise<Browser> | undefined;
  private readonly sessions = new Map<string, Session>();
  private readonly origins: ReadonlySet<string>;
  constructor(origins: readonly string[] = [], private readonly timeoutMs = 5000, private readonly maxContentBytes = 524288) {
    this.origins = new Set(origins.map((origin) => {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new ToolFault('INVALID_BROWSER_ORIGIN', 'Configure exact HTTP(S) origins without credentials or paths.', 'VALIDATION');
      return url.origin;
    }));
  }
  validateUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new ToolFault('INVALID_BROWSER_URL', 'A valid absolute HTTP(S) URL is required.', 'VALIDATION'); }
    if (value.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || !this.origins.has(url.origin)) throw new ToolFault('BROWSER_ORIGIN_DENIED', 'Browser destination is not explicitly allowed.', 'PERMISSION');
    return url;
  }
  private async fetchDocument(value: string, signal: AbortSignal): Promise<{ url: string; body: Buffer; contentType: string }> {
    let url = this.validateUrl(value);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetch(url, { redirect: 'manual', signal, headers: { Accept: 'text/html,text/plain' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new ToolFault('INVALID_REDIRECT', 'Browser response has an invalid redirect.');
        url = this.validateUrl(new URL(location, url).href); // Validate BEFORE any redirected network request.
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new ToolFault('BROWSER_HTTP_ERROR', 'Allowed browser destination returned an unsuccessful response.', 'TRANSIENT', 'SAFE_READ'); }
      const contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
      if (!['text/html', 'text/plain'].includes(contentType)) { await response.body?.cancel(); throw new ToolFault('BROWSER_CONTENT_DENIED', 'Only readable HTML and plain text are supported.'); }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > this.maxContentBytes) { await reader.cancel(); throw new ToolFault('BROWSER_CONTENT_LIMIT', 'Browser document exceeds the content limit.'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      return { url: url.href, body: Buffer.concat(chunks), contentType };
    }
    throw new ToolFault('BROWSER_REDIRECT_LIMIT', 'Browser redirect limit exceeded.');
  }
  async open(owner: string, value: string, signal?: AbortSignal): Promise<{ sessionId: string; url: string; title: string }> {
    this.validateUrl(value);
    if (signal?.aborted) throw new ToolFault('CANCELLED', 'Browser request was cancelled.', 'TRANSIENT', 'SAFE_READ');
    const bound = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    if (!this.browser) {
      this.launch ??= chromium.launch({ headless: true, timeout: this.timeoutMs });
      try { this.browser = await this.launch; } catch { this.launch = undefined; throw new ToolFault('BROWSER_UNAVAILABLE', 'Install the pinned Playwright Chromium browser before using this adapter.', 'PERMANENT'); }
    }
    if (bound.aborted) throw new ToolFault('BROWSER_TIMEOUT', 'Browser operation timed out or was cancelled during startup.', 'TRANSIENT', 'SAFE_READ');
    for (const session of this.sessions.values()) if (session.owner === owner) { await session.context.close(); this.sessions.delete(session.id); }
    if (this.sessions.size >= 4) throw new ToolFault('BROWSER_SESSION_LIMIT', 'Browser session limit reached.');
    const context = await this.browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false });
    const onAbort = () => { void context.close().catch(() => {}); };
    bound.addEventListener('abort', onAbort, { once: true });
    // The deadline may expire while newContext is awaiting Chromium. Adding an
    // abort listener after an already-fired signal does not invoke it.
    if (bound.aborted) { bound.removeEventListener('abort', onAbort); await context.close(); throw new ToolFault('BROWSER_TIMEOUT', 'Browser operation timed out or was cancelled during context creation.', 'TRANSIENT', 'SAFE_READ'); }
    let failure: unknown;
    let finalUrl = value;
    try {
      const page = await context.newPage();
      await context.route('**/*', async (route) => {
        if (!route.request().isNavigationRequest() || route.request().frame() !== page.mainFrame()) { await route.abort(); return; }
        try {
          const document = await this.fetchDocument(route.request().url(), bound);
          finalUrl = document.url;
          await route.fulfill({ status: 200, body: document.body, contentType: `${document.contentType}; charset=utf-8`, headers: { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'no-store' } });
        } catch (error) { failure = error; await route.abort().catch(() => {}); }
      });
      await page.goto(value, { timeout: this.timeoutMs, waitUntil: 'domcontentloaded' });
      if (failure) throw failure;
      this.validateUrl(page.url()); this.validateUrl(finalUrl);
      const id = randomUUID();
      this.sessions.set(id, { id, owner, context, page, finalUrl });
      return { sessionId: id, url: finalUrl, title: (await page.title()).slice(0, 300) };
    } catch (error) {
      await context.close().catch(() => {});
      if (failure instanceof ToolFault) throw failure;
      if (error instanceof ToolFault) throw error;
      throw new ToolFault(bound.aborted ? 'BROWSER_TIMEOUT' : 'BROWSER_NAVIGATION_FAILED', bound.aborted ? 'Browser operation timed out or was cancelled.' : 'Browser navigation failed.', 'TRANSIENT', 'SAFE_READ');
    } finally { bound.removeEventListener('abort', onAbort); }
  }
  async snapshot(owner: string, sessionId: string): Promise<BrowserSnapshot> {
    const session = this.sessions.get(sessionId);
    if (!session || session.owner !== owner) throw new ToolFault('BROWSER_SESSION_DENIED', 'Browser session is missing or belongs to another execution context.', 'PERMISSION');
    this.validateUrl(session.page.url()); this.validateUrl(session.finalUrl);
    const text = (await session.page.locator('body').innerText({ timeout: this.timeoutMs })).slice(0, 10000);
    const headings = (await session.page.getByRole('heading').allTextContents()).slice(0, 40).map((item) => item.slice(0, 300));
    const links = await session.page.locator('a[href]').evaluateAll((elements) => elements.slice(0, 40).map((element) => ({ text: (element.textContent ?? '').slice(0, 200), href: (element.getAttribute('href') ?? '').slice(0, 2048) })));
    return { sessionId, url: session.finalUrl, title: (await session.page.title()).slice(0, 300), text, headings, links };
  }
  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.context.close().catch(() => {})));
    this.sessions.clear();
    const running = this.browser ?? await this.launch?.catch(() => undefined);
    await running?.close(); this.browser = undefined; this.launch = undefined;
  }
}
