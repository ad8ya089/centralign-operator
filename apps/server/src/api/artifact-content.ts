import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ArtifactRecordSchema, DocumentCitationSchema, IdentifierSchema, JsonObjectSchema, parseStoredJson } from '@centralign/shared';
import { AgentFault } from '../agent/contracts.js';
import { sha256 } from '../persistence/json.js';

export const MAX_DOWNLOAD_BYTES = 524288;
const previewTypes = new Set(['text/plain', 'text/markdown', 'application/json']);
export function readRunArtifact(db: Database.Database, root: string, runId: string, artifactId: string) {
  const raw = db.prepare('SELECT id,run_id AS runId,step_id AS stepId,name,path,mime_type AS mimeType,content_hash AS contentHash,metadata_json,created_at AS createdAt FROM artifacts WHERE run_id=? AND id=?').get(runId, artifactId);
  if (!raw) throw new AgentFault('ARTIFACT_NOT_FOUND', 'Artifact not found for this run.', 'VALIDATION');
  const row = z.record(z.string(), z.unknown()).parse(raw); const { metadata_json, ...fields } = row;
  const artifact = ArtifactRecordSchema.parse({ ...fields, metadata: parseStoredJson(z.string().parse(metadata_json), JsonObjectSchema) });
  const destination = resolve(root, artifact.path); const within = relative(resolve(root), destination);
  if (within.startsWith('..') || isAbsolute(within)) throw new AgentFault('ARTIFACT_UNSAFE', 'Artifact location is unsafe.', 'VALIDATION');
  let descriptor: number | undefined;
  try {
    let ancestor = parse(destination).root;
    for (const segment of destination.slice(ancestor.length).split(sep).filter(Boolean)) {
      ancestor = resolve(ancestor, segment);
      if (lstatSync(ancestor).isSymbolicLink()) throw new AgentFault('ARTIFACT_UNSAFE', 'Linked artifacts cannot be accessed.', 'VALIDATION');
    }
    const actual = relative(realpathSync(root), realpathSync(destination));
    if (actual.startsWith('..') || isAbsolute(actual)) throw new AgentFault('ARTIFACT_UNSAFE', 'Artifact location is unsafe.', 'VALIDATION');
    const before = lstatSync(destination);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_DOWNLOAD_BYTES) throw new AgentFault('ARTIFACT_UNSAFE', 'Artifact is not a supported bounded file.', 'VALIDATION');
    descriptor = openSync(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new AgentFault('ARTIFACT_CHANGED', 'Artifact changed while being opened.', 'CONFLICT');
    // Bound allocation/read even if another local process grows the file after stat.
    const buffer = Buffer.alloc(opened.size + 1); let count = 0;
    while (count < buffer.length) { const size = readSync(descriptor, buffer, count, buffer.length - count, null); if (!size) break; count += size; }
    const bytes = buffer.subarray(0, count);
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES || sha256(bytes) !== artifact.contentHash || typeof artifact.metadata['sizeBytes'] === 'number' && artifact.metadata['sizeBytes'] !== bytes.byteLength) throw new AgentFault('ARTIFACT_CHANGED', 'Artifact content verification failed. The file cannot be presented as verified.', 'CONFLICT');
    const sources = z.array(DocumentCitationSchema).parse(artifact.metadata['sources'] ?? []);
    for (const source of sources) {
      if (!db.prepare('SELECT 1 FROM company_documents WHERE id=? AND content_hash=?').get(source.documentId, source.contentHash) || source.chunkId !== null && !db.prepare('SELECT 1 FROM document_chunks WHERE id=? AND document_id=?').get(source.chunkId, source.documentId)) throw new AgentFault('ARTIFACT_CHANGED', 'Artifact source verification failed.', 'CONFLICT');
    }
    const filename = artifact.name.replace(/[^a-zA-Z0-9._ -]/g, '-').replace(/[. ]+$/g, '').slice(0, 100) || 'artifact';
    return { bytes, filename, hash: artifact.contentHash, mimeType: previewTypes.has(artifact.mimeType) ? artifact.mimeType : 'application/octet-stream' };
  } catch (error) {
    if (error instanceof AgentFault) throw error;
    throw new AgentFault('ARTIFACT_UNAVAILABLE', 'Artifact bytes are unavailable or unsafe. No file was returned.', 'CONFLICT');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function registerArtifactRoute(app: FastifyInstance, db: Database.Database, root: string): void {
  app.get('/api/v1/runs/:runId/artifacts/:artifactId/content', async (request, reply) => {
    const params = z.strictObject({ runId: IdentifierSchema.max(200), artifactId: IdentifierSchema.max(200) }).parse(request.params);
    z.strictObject({}).parse(request.query);
    const value = readRunArtifact(db, root, params.runId, params.artifactId);
    return reply.header('Content-Type', value.mimeType).header('Content-Disposition', `attachment; filename="${value.filename}"`)
      .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'no-store').header('ETag', `"sha256-${value.hash}"`).send(value.bytes);
  });
}
