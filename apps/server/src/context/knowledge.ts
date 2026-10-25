import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { IndexedDocumentSchema, KnowledgeHitSchema, RelativePathSchema } from '@centralign/shared';
import type { IndexedDocument, KnowledgeHit } from '@centralign/shared';
import { sha256 } from '../persistence/json.js';
import { ToolFault, notFound } from '../tools/errors.js';

export const SearchKnowledgeInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(300).refine((query) => /[\p{L}\p{N}]/u.test(query), 'Query needs a word'),
  limit: z.number().int().min(1).max(20).default(5),
});
const DocumentRowSchema = z.strictObject({ id: z.string(), title: z.string(), source_path: z.string(), content_hash: z.string(), indexed_content: z.string(), indexed_at: z.string() });

export function normalizeName(name: string): string { return name.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}@.]+/gu, ' ').trim().replace(/\s+/g, ' '); }

function fixtureFile(root: string, sourcePath: string): string {
  if (!RelativePathSchema.safeParse(sourcePath).success || !sourcePath.endsWith('.md')) throw new ToolFault('INVALID_SOURCE_PATH', 'Only relative Markdown fixture paths are allowed.', 'VALIDATION');
  const permittedRoot = realpathSync(root);
  let candidate: string;
  try { candidate = realpathSync(resolve(permittedRoot, sourcePath)); }
  catch { throw new ToolFault('SOURCE_MISSING', 'A required source fixture is missing.'); }
  const remainder = relative(permittedRoot, candidate);
  if (isAbsolute(remainder) || remainder.startsWith('..') || remainder === '') throw new ToolFault('SOURCE_OUTSIDE_ROOT', 'The source escapes the permitted fixture directory.', 'PERMISSION');
  if (!statSync(candidate).isFile() || statSync(candidate).size > 131072) throw new ToolFault('INVALID_SOURCE', 'Source must be a Markdown file of at most 128 KiB.');
  return candidate;
}

function chunks(content: string): { heading: string | null; content: string }[] {
  let heading: string | null = null;
  const result: { heading: string | null; content: string }[] = [];
  for (const paragraph of content.split(/\n\s*\n/)) {
    const text = paragraph.trim();
    if (!text) continue;
    const match = /^#{1,6}\s+(.+?)(?:\n|$)/.exec(text);
    if (match) heading = match[1] ?? null;
    for (let offset = 0; offset < text.length; offset += 1400) result.push({ heading, content: text.slice(offset, offset + 1400) });
  }
  return result;
}

export interface SourceFixture { readonly id: string; readonly filename: string }
export const COMPANY_FIXTURES: readonly SourceFixture[] = [
  { id: 'doc-onboarding-sop', filename: 'onboarding-sop.md' },
  { id: 'doc-security-policy', filename: 'security-policy.md' },
  { id: 'doc-acme-notes', filename: 'account-notes-acme-logistics.md' },
];

/** Read/validate every file before a single atomic index refresh. Failed ingestion preserves the prior index. */
export function indexCompanyDocuments(db: Database.Database, fixtureRoot: string, sources: readonly SourceFixture[] = COMPANY_FIXTURES, now = new Date().toISOString()): number {
  const prepared = sources.map((source) => {
    const bytes = readFileSync(fixtureFile(fixtureRoot, source.filename));
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
    catch { throw new ToolFault('INVALID_SOURCE', 'Source must contain valid UTF-8 text.'); }
    const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
    if (!title || content.includes('\0') || content.trim().length < 20) throw new ToolFault('INVALID_SOURCE', 'Source must contain a title and meaningful Markdown text.');
    return { ...source, title, content, hash: sha256(bytes), chunks: chunks(content) };
  });
  return db.transaction(() => {
    let changed = 0;
    for (const source of prepared) {
      const existing = db.prepare('SELECT content_hash, indexed_at FROM company_documents WHERE id = ?').get(source.id) as { content_hash: string; indexed_at: string | null } | undefined;
      if (existing?.content_hash === source.hash && existing.indexed_at !== null) continue;
      const metadata = JSON.stringify({ trust: 'untrusted_source', format: 'markdown', fixture: true });
      db.prepare(`INSERT INTO company_documents (id,title,source_path,content_hash,metadata_json,created_at,updated_at,indexed_content,indexed_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,source_path=excluded.source_path,content_hash=excluded.content_hash,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at,indexed_content=excluded.indexed_content,indexed_at=excluded.indexed_at`)
        .run(source.id, source.title, `fixtures/company/${source.filename}`, source.hash, metadata, now, now, source.content, now);
      db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(source.id);
      for (const [index, chunk] of source.chunks.entries()) {
        db.prepare('INSERT INTO document_chunks (id,document_id,chunk_index,heading,content,content_hash) VALUES (?,?,?,?,?,?)')
          .run(`${source.id}:${source.hash.slice(0, 16)}:${index}`, source.id, index, chunk.heading, chunk.content, sha256(chunk.content));
      }
      changed++;
    }
    return changed;
  }).immediate();
}

export function readCompanyDocument(db: Database.Database, id: string): IndexedDocument {
  z.string().min(1).max(200).parse(id);
  const row = db.prepare('SELECT id,title,source_path,content_hash,indexed_content,indexed_at FROM company_documents WHERE id = ? AND indexed_at IS NOT NULL').get(id);
  if (!row) return notFound('Indexed document');
  const document = DocumentRowSchema.parse(row);
  return IndexedDocumentSchema.parse({ id: document.id, title: document.title, sourcePath: document.source_path, contentHash: document.content_hash, content: document.indexed_content, indexedAt: document.indexed_at, trust: 'untrusted_source' });
}

export function searchCompanyKnowledge(db: Database.Database, raw: unknown): { hits: KnowledgeHit[]; mode: 'fts5' | 'text' } {
  const input = SearchKnowledgeInputSchema.parse(raw);
  const tokens = [...new Set(input.query.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu))].slice(0, 16);
  const fts = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'document_chunks_fts'").get());
  const projection = 'd.id AS documentId,d.title,d.source_path AS sourcePath,d.content_hash AS contentHash,c.id AS chunkId,c.chunk_index AS chunkIndex,c.heading,c.content';
  // Tokens are literal quoted FTS terms, never caller-supplied FTS expressions.
  const query = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
  const rows = fts
    ? db.prepare(`SELECT ${projection} FROM document_chunks_fts JOIN document_chunks c ON c.rowid = document_chunks_fts.rowid JOIN company_documents d ON d.id = c.document_id WHERE document_chunks_fts MATCH ? ORDER BY bm25(document_chunks_fts),d.id,c.chunk_index LIMIT ?`).all(query, input.limit)
    : db.prepare(`SELECT ${projection} FROM document_chunks c JOIN company_documents d ON d.id=c.document_id WHERE ${tokens.map(() => "instr(lower(c.content), ?) > 0").join(' OR ')} ORDER BY d.id,c.chunk_index LIMIT ?`).all(...tokens, input.limit);
  const hits = rows.map((rawRow) => {
    const row = z.record(z.string(), z.unknown()).parse(rawRow);
    const content = z.string().parse(row['content']);
    const lower = content.toLocaleLowerCase('en-US');
    const position = Math.min(...tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0));
    const offset = Number.isFinite(position) ? Math.max(0, position - 100) : 0;
    const { content: _content, ...metadata } = row;
    return KnowledgeHitSchema.parse({ ...metadata, excerpt: content.slice(offset, offset + 1200), trust: 'untrusted_source' });
  });
  return { hits, mode: fts ? 'fts5' : 'text' };
}
