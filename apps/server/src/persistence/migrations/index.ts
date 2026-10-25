import { foundationMigration } from './0001-foundation.js';

export interface Migration { readonly version: number; readonly name: string; readonly sql: string }
export const migrations: readonly Migration[] = Object.freeze([foundationMigration]);
