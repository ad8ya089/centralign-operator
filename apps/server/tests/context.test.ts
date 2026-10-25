import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT } from '../src/config/paths.js';
import { COMPANY_FIXTURES, indexCompanyDocuments, readCompanyDocument, searchCompanyKnowledge } from '../src/context/knowledge.js';
import { seedDemoData } from '../src/persistence/seed.js';
import { temporaryDirectory, testDatabase } from './helpers.js';

describe('company ingestion and retrieval', () => {
  let fixture: ReturnType<typeof testDatabase>;
  let directory: ReturnType<typeof temporaryDirectory>;
  let root: string;
  beforeEach(() => {
    fixture = testDatabase(); directory = temporaryDirectory(); root = join(directory.path, 'fixtures'); mkdirSync(root);
    for (const source of COMPANY_FIXTURES) copyFileSync(join(REPOSITORY_ROOT, 'fixtures', 'company', source.filename), join(root, source.filename));
  });
  afterEach(() => { fixture.cleanup(); directory.cleanup(); });

  it('seeds once, keeps deterministic IDs, and preserves edited customer records', () => {
    expect(seedDemoData(fixture.db, root)).toEqual({ insertedCustomers: 1, indexedDocuments: 3 });
    fixture.db.prepare("UPDATE customers SET company_name='Edited Acme',status='ONBOARDING' WHERE id=?").run('customer-acme-logistics');
    expect(seedDemoData(fixture.db, root)).toEqual({ insertedCustomers: 0, indexedDocuments: 0 });
    expect(fixture.db.prepare('SELECT company_name,status FROM customers').all()).toEqual([{ company_name: 'Edited Acme', status: 'ONBOARDING' }]);
    expect(fixture.db.prepare('SELECT count(*) AS count FROM company_documents').get()).toEqual({ count: 3 });
  });
  it('returns relevant SOP and security excerpts with stable source provenance', () => {
    seedDemoData(fixture.db, root);
    const sop = searchCompanyKnowledge(fixture.db, { query: 'deliverables', limit: 2 });
    expect(sop.mode).toBe('fts5');
    expect(sop.hits.some((hit) => hit.documentId === 'doc-onboarding-sop' && hit.excerpt.includes('deliverables'))).toBe(true);
    const security = searchCompanyKnowledge(fixture.db, { query: 'questionnaire', limit: 20 });
    expect(security.hits.some((hit) => hit.documentId === 'doc-security-policy')).toBe(true);
    for (const hit of security.hits) {
      expect(hit.contentHash).toMatch(/^[a-f0-9]{64}$/); expect(hit.sourcePath).toMatch(/^fixtures\/company\//);
      expect(hit.chunkId).toContain(hit.documentId); expect(hit.trust).toBe('untrusted_source');
    }
    expect(searchCompanyKnowledge(fixture.db, { query: 'xylophonemissingterm' }).hits).toEqual([]);
    expect(searchCompanyKnowledge(fixture.db, { query: 'onboarding', limit: 1 }).hits).toHaveLength(1);
  });
  it('refreshes changed content and removes stale chunks and FTS hits', () => {
    seedDemoData(fixture.db, root);
    const before = readCompanyDocument(fixture.db, 'doc-security-policy');
    const oldChunks = fixture.db.prepare('SELECT id FROM document_chunks WHERE document_id=?').all(before.id);
    writeFileSync(join(root, 'security-policy.md'), '# Revised security\n\nQuasarprerequisite replaces the old text.\n');
    expect(seedDemoData(fixture.db, root).indexedDocuments).toBe(1);
    const after = readCompanyDocument(fixture.db, before.id);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(searchCompanyKnowledge(fixture.db, { query: 'Quasarprerequisite' }).hits[0]?.documentId).toBe(before.id);
    for (const chunk of oldChunks) expect(fixture.db.prepare('SELECT 1 FROM document_chunks WHERE id=?').get((chunk as { id: string }).id)).toBeUndefined();
  });
  it('does not mark missing or malformed ingestion as successful or partially refresh sources', () => {
    writeFileSync(join(root, 'security-policy.md'), 'not a valid titled source');
    expect(() => seedDemoData(fixture.db, root)).toThrow('title');
    expect(fixture.db.prepare('SELECT count(*) AS count FROM company_documents').get()).toEqual({ count: 0 });
    expect(fixture.db.prepare('SELECT count(*) AS count FROM customers').get()).toEqual({ count: 0 });
    expect(() => indexCompanyDocuments(fixture.db, root, [{ id: 'missing', filename: 'missing.md' }])).toThrow('missing');
  });
  it('rejects traversal, absolute paths, and links outside the fixture directory', () => {
    const outside = join(directory.path, 'outside'); mkdirSync(outside);
    const privateFile = join(outside, 'private.md'); writeFileSync(privateFile, '# Outside\n\nThis must not be indexed.');
    symlinkSync(outside, join(root, 'escape'), 'junction');
    for (const filename of ['../outside/private.md', privateFile, 'escape/private.md']) expect(() => indexCompanyDocuments(fixture.db, root, [{ id: 'bad', filename }])).toThrow();
    expect(readFileSync(privateFile, 'utf8')).toContain('must not be indexed');
    expect(fixture.db.prepare('SELECT count(*) AS count FROM company_documents').get()).toEqual({ count: 0 });
  });
  it('validates inputs and treats FTS-looking operators as literal search terms', () => {
    seedDemoData(fixture.db, root);
    for (const input of [{ query: '' }, { query: '* OR -' }, { query: 'x', limit: 0 }, { query: 'x', limit: 21 }, { query: 'x'.repeat(301) }]) {
      if ((input as { query: string }).query !== '* OR -') expect(() => searchCompanyKnowledge(fixture.db, input)).toThrow();
    }
    expect(() => searchCompanyKnowledge(fixture.db, { query: '" OR questionnaire *' })).not.toThrow();
    expect(() => readCompanyDocument(fixture.db, 'missing')).toThrow('not found');
    expect(() => readCompanyDocument(fixture.db, '')).toThrow();
  });
  it('supports deterministic fallback search when the optional FTS index is absent', () => {
    seedDemoData(fixture.db, root);
    fixture.db.exec('DROP TRIGGER document_chunks_fts_insert; DROP TRIGGER document_chunks_fts_delete; DROP TRIGGER document_chunks_fts_update; DROP TABLE document_chunks_fts;');
    const result = searchCompanyKnowledge(fixture.db, { query: 'questionnaire', limit: 1 });
    expect(result.mode).toBe('text'); expect(result.hits).toHaveLength(1);
    expect(searchCompanyKnowledge(fixture.db, { query: 'notarealword' }).hits).toEqual([]);
  });
});
