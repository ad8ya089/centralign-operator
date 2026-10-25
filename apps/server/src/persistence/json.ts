import { createHash } from 'node:crypto';
import { JsonValueSchema } from '@centralign/shared';
import type { JsonValue } from '@centralign/shared';

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function canonicalJson(value: unknown): string {
  function sort(item: JsonValue): JsonValue {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key]!)]));
    return item;
  }
  return JSON.stringify(sort(JsonValueSchema.parse(value)));
}
