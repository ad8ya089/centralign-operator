export type FailureCategory = 'VALIDATION' | 'BUSINESS_RULE' | 'PERMISSION' | 'TRANSIENT' | 'PERMANENT' | 'UNKNOWN_OUTCOME';
export type Retryability = 'NEVER' | 'SAFE_READ' | 'RECONCILE';
export class ToolFault extends Error {
  constructor(readonly code: string, message: string, readonly category: FailureCategory = 'BUSINESS_RULE', readonly retryability: Retryability = 'NEVER') { super(message); this.name = 'ToolFault'; }
}
export const notFound = (entity: string): never => { throw new ToolFault('NOT_FOUND', `${entity} was not found.`); };
