import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RestrictedBrowser } from '../src/browser/adapter.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { toolFixture, success } from './tool-helpers.js';
import { z } from 'zod';

describe('restricted Playwright adapter on isolated loopback origins', () => {
  let origin: string;
  let deniedOrigin: string;
  let deniedRequests = 0;
  const denied = createServer((_request, response) => { deniedRequests++; response.end('Forbidden target'); });
  const allowed = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { Location: `${deniedOrigin}/escape` }); response.end(); return; }
    if (request.url === '/allowed-redirect') { response.writeHead(302, { Location: '/' }); response.end(); return; }
    if (request.url === '/slow') return;
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/large') { response.end(`<p>${'X'.repeat(5000)}</p>`); return; }
    response.end(`<html><head><title>Local onboarding fixture</title></head><body><h1>Customer onboarding</h1><p>Security questionnaire required.</p><a href="/checklist">Checklist</a><script>fetch('${deniedOrigin}/script')</script><img src="${deniedOrigin}/image"></body></html>`);
  });
  let browser: RestrictedBrowser;
  beforeAll(async () => {
    await new Promise<void>((resolve) => denied.listen(0, '127.0.0.1', resolve));
    deniedOrigin = `http://127.0.0.1:${(denied.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => allowed.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(allowed.address() as AddressInfo).port}`;
    // Use the production 5s operation budget for positive cold-start checks.
    // The dedicated deadline test below still exercises a 2s limit.
    browser = new RestrictedBrowser([origin], 5000, 2000);
  });
  afterAll(async () => {
    await browser.close();
    allowed.closeAllConnections(); denied.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => allowed.close(() => resolve())), new Promise<void>((resolve) => denied.close(() => resolve()))]);
  });
  it('defaults to deny and rejects unsafe URL schemes, credentials, and origin configuration', () => {
    const disabled = new RestrictedBrowser();
    expect(() => disabled.validateUrl(origin)).toThrow('not explicitly allowed');
    for (const url of ['file:///etc/passwd', 'data:text/html,test', `${deniedOrigin}/`, `${origin.replace('http://', 'http://user:pass@')}/`]) expect(() => browser.validateUrl(url)).toThrow();
    expect(() => new RestrictedBrowser([`${origin}/path`])).toThrow('exact HTTP(S) origins');
  });
  it('opens an allowed page and reads semantic text without script or subresource access', async () => {
    const opened = await browser.open('owner-one', `${origin}/`);
    const snapshot = await browser.snapshot('owner-one', opened.sessionId);
    expect(snapshot.title).toBe('Local onboarding fixture'); expect(snapshot.text).toContain('Security questionnaire required');
    expect(snapshot.headings).toEqual(['Customer onboarding']); expect(snapshot.links).toEqual([{ text: 'Checklist', href: '/checklist' }]);
    expect(deniedRequests).toBe(0);
    await expect(browser.snapshot('another-owner', opened.sessionId)).rejects.toMatchObject({ code: 'BROWSER_SESSION_DENIED' });
  // Cold Chromium startup + navigation + independent snapshot can exceed Vitest's 5s
  // outer test limit on a busy Windows host. Production deadlines remain bounded.
  }, 15000);
  it('allows same-origin redirects but blocks a cross-origin redirect before requesting its target', async () => {
    const opened = await browser.open('owner-redirect', `${origin}/allowed-redirect`);
    expect(opened.url).toBe(`${origin}/`);
    await expect(browser.open('owner-redirect', `${origin}/redirect`)).rejects.toMatchObject({ code: 'BROWSER_ORIGIN_DENIED' });
    expect(deniedRequests).toBe(0);
  });
  it('uses the same typed browser tools and execution ledger as other server tools', async () => {
    const fixture = toolFixture();
    try {
      const executor = new ToolExecutor(fixture.db, fixture.registry, fixture.workspace, browser);
      const opened = success(await executor.execute('browser_open', { url: `${origin}/` }, fixture.context()), z.object({ sessionId: z.string() }));
      const snapshot = success(await executor.execute('browser_snapshot', { sessionId: opened.sessionId }, fixture.context()), z.object({ text: z.string() }));
      expect(snapshot.text).toContain('questionnaire');
    } finally { fixture.cleanup(); }
  });
  it('bounds content and navigation timeouts', async () => {
    const bounded = new RestrictedBrowser([origin], 2000, 2000);
    try {
      await expect(bounded.open('owner-large', `${origin}/large`)).rejects.toMatchObject({ code: 'BROWSER_CONTENT_LIMIT' });
      await expect(bounded.open('owner-slow', `${origin}/slow`)).rejects.toMatchObject({ category: 'TRANSIENT' });
    } finally { await bounded.close(); }
  }, 10000);
  it('closes isolated sessions and can be closed repeatedly', async () => {
    const opened = await browser.open('owner-close', `${origin}/`);
    await browser.close(); await browser.close();
    await expect(browser.snapshot('owner-close', opened.sessionId)).rejects.toMatchObject({ code: 'BROWSER_SESSION_DENIED' });
  });
});
