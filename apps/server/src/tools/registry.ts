import { z } from 'zod';
import { JsonValueSchema } from '@centralign/shared';
import { EvidenceSchema, ToolMetadataSchema } from './contracts.js';
import type { HandlerContext, ToolDefinition, ToolMetadata, ToolValue } from './contracts.js';
import type { JsonValue } from '@centralign/shared';
import { ToolFault } from './errors.js';

export interface RegisteredTool {
  readonly metadata: ToolMetadata;
  readonly inputSchema: z.ZodType;
  readonly resultSchema: z.ZodType;
  readonly prepare: (input: unknown) => PreparedToolInvocation;
  readonly parseValue: (value: unknown) => ToolValue<JsonValue>;
}
export interface PreparedToolInvocation {
  readonly input: JsonValue;
  readonly invoke: (context: HandlerContext) => unknown;
  readonly reconcile: ((context: HandlerContext) => unknown) | undefined;
}
export class ToolRegistry {
  private readonly definitions = new Map<string, RegisteredTool>();
  register<I, O>(definition: ToolDefinition<I, O>): this {
    const metadata = ToolMetadataSchema.parse(definition.metadata);
    if (this.definitions.has(metadata.name)) throw new ToolFault('DUPLICATE_TOOL', 'A tool with this name is already registered.', 'VALIDATION');
    if ((metadata.risk === 'read') !== !metadata.changesPersistentState || (metadata.persistence === 'none') !== !metadata.changesPersistentState) throw new ToolFault('INVALID_METADATA', 'Tool risk and persistence metadata are inconsistent.', 'VALIDATION');
    if (metadata.changesPersistentState && definition.handler.constructor.name === 'AsyncFunction') throw new ToolFault('ASYNC_WRITE_FORBIDDEN', 'Local write handlers must be synchronous.', 'VALIDATION');
    const parseValue = (raw: unknown): ToolValue<JsonValue> => {
      const value = z.strictObject({ data: definition.resultSchema, evidence: z.array(EvidenceSchema) }).parse(raw);
      return { data: JsonValueSchema.parse(value.data), evidence: value.evidence };
    };
    this.definitions.set(metadata.name, {
      metadata: Object.freeze({ ...metadata, requiredScopes: Object.freeze([...metadata.requiredScopes]) }),
      inputSchema: definition.inputSchema, resultSchema: definition.resultSchema,
      prepare: (raw) => {
        const validated = definition.inputSchema.parse(raw);
        return {
          input: JsonValueSchema.parse(validated),
          invoke: (context) => definition.handler(validated, context),
          reconcile: definition.reconcile ? (context) => definition.reconcile!(validated, context) : undefined,
        };
      },
      parseValue,
    });
    return this;
  }
  resolve(name: string): RegisteredTool {
    const tool = this.definitions.get(name);
    if (!tool) throw new ToolFault('UNKNOWN_TOOL', 'The requested tool is not registered.', 'VALIDATION');
    return tool;
  }
  list(): readonly ToolMetadata[] { return [...this.definitions.values()].map((tool) => tool.metadata); }
}
