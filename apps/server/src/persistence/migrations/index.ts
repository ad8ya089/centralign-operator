import { foundationMigration } from './0001-foundation.js';
import { contextToolsMigration } from './0002-context-tools.js';
import { agentRuntimeMigration } from './0003-agent-runtime.js';

export interface Migration { readonly version: number; readonly name: string; readonly sql: string; readonly optionalFts5Sql?: string }
export const migrations: readonly Migration[] = Object.freeze([foundationMigration, contextToolsMigration, agentRuntimeMigration]);
