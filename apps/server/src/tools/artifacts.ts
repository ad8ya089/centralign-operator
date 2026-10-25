import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { ArtifactRecordSchema, DocumentCitationSchema, parseStoredJson, JsonObjectSchema } from '@centralign/shared';
import type { HandlerContext, ToolValue } from './contracts.js';
import { sha256 } from '../persistence/json.js';
import { ToolFault } from './errors.js';

export const ArtifactInputSchema = z.strictObject({
  filename: z.string().max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).refine((name) => !name.endsWith('.') && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name), 'Unsafe filename'),
  content: z.string().min(1).max(100000), mimeType: z.enum(['text/markdown', 'text/plain', 'application/json']),
  sources: z.array(DocumentCitationSchema).max(30).default([]),
});
export const ArtifactResultSchema = ArtifactRecordSchema.extend({ sizeBytes: z.number().int().nonnegative(), verificationReference: z.string().min(1) });
type ArtifactInput = z.infer<typeof ArtifactInputSchema>;
type ArtifactResult = z.infer<typeof ArtifactResultSchema>;

function safeDirectories(directory: string, create: boolean): void {
  const absolute = resolve(directory);
  let current = parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) {
      if (!create) throw new ToolFault('UNRECONCILED_ARTIFACT', 'No matching file exists to reconcile.', 'UNKNOWN_OUTCOME', 'RECONCILE');
      mkdirSync(current);
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ToolFault('UNSAFE_ARTIFACT_PATH', 'Artifact directories must not contain links or non-directory entries.', 'PERMISSION');
  }
}

export class ArtifactStore {
  constructor(readonly workspaceRoot: string) {}
  write(input: ArtifactInput, context: HandlerContext, reconcileOnly = false): ToolValue<ArtifactResult> {
    for (const source of input.sources) {
      const row = context.db.prepare('SELECT content_hash FROM company_documents WHERE id=? AND indexed_at IS NOT NULL').get(source.documentId) as { content_hash: string } | undefined;
      if (!row || row.content_hash !== source.contentHash || (source.chunkId !== null && !context.db.prepare('SELECT 1 FROM document_chunks WHERE id=? AND document_id=?').get(source.chunkId, source.documentId))) throw new ToolFault('STALE_SOURCE', 'Artifact source reference is missing or stale.');
    }
    const storedPath = `artifacts/runs/${sha256(context.runId).slice(0, 24)}/${sha256(context.executionId).slice(0, 24)}/${input.filename}`;
    const destination = resolve(this.workspaceRoot, storedPath);
    const directory = resolve(destination, '..');
    const remainder = relative(resolve(this.workspaceRoot), destination);
    if (remainder.startsWith('..') || parse(remainder).root) throw new ToolFault('UNSAFE_ARTIFACT_PATH', 'Artifact destination escapes the workspace.', 'PERMISSION');
    safeDirectories(directory, !reconcileOnly);
    const bytes = Buffer.from(input.content, 'utf8');
    const hash = sha256(bytes);
    if (existsSync(destination)) {
      const stat = lstatSync(destination);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size !== bytes.length || sha256(readFileSync(destination)) !== hash) throw new ToolFault('ARTIFACT_CONFLICT', 'An existing artifact cannot be overwritten.', 'PERMISSION');
    } else {
      if (reconcileOnly) throw new ToolFault('UNRECONCILED_ARTIFACT', 'No matching file exists to reconcile.', 'UNKNOWN_OUTCOME', 'RECONCILE');
      let descriptor: number | undefined;
      try { descriptor = openSync(destination, 'wx', 0o600); writeFileSync(descriptor, bytes); fsyncSync(descriptor); }
      finally { if (descriptor !== undefined) closeSync(descriptor); }
    }
    const id = `artifact-${context.executionId}`;
    const metadata = { sizeBytes: bytes.length, sources: input.sources, executionId: context.executionId };
    context.db.prepare('INSERT INTO artifacts (id,run_id,step_id,name,path,mime_type,content_hash,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(id, context.runId, context.stepId, input.filename, storedPath, input.mimeType, hash, JSON.stringify(metadata), context.now());
    const row = context.db.prepare('SELECT id,run_id AS runId,step_id AS stepId,name,path,mime_type AS mimeType,content_hash AS contentHash,metadata_json,created_at AS createdAt FROM artifacts WHERE id=?').get(id);
    const parsed = z.record(z.string(), z.unknown()).parse(row);
    const { metadata_json, ...fields } = parsed;
    const record = ArtifactRecordSchema.parse({ ...fields, metadata: parseStoredJson(z.string().parse(metadata_json), JsonObjectSchema) });
    const verificationReference = `artifact:${id}#sha256=${hash}`;
    return { data: ArtifactResultSchema.parse({ ...record, sizeBytes: bytes.length, verificationReference }), evidence: [{ kind: 'artifact', id, reference: verificationReference, metadata: { contentHash: hash, sizeBytes: bytes.length, sources: input.sources } }] };
  }
}
