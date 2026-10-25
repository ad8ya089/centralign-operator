import { AgentFault } from './contracts.js';
import type { ModelProvider, StructuredModelRequest } from './contracts.js';

export type ScriptedResponse = unknown | ((request: StructuredModelRequest) => unknown | Promise<unknown>);
/** Explicit test injection only. Production composition never instantiates this provider. */
export class FakeModelProvider implements ModelProvider {
  readonly configured = true;
  readonly requests: StructuredModelRequest[] = [];
  constructor(private readonly responses: ScriptedResponse[]) {}
  async generateStructured(request: StructuredModelRequest): Promise<unknown> {
    this.requests.push(request);
    if (!this.responses.length) throw new AgentFault('FAKE_SCRIPT_EXHAUSTED', 'The explicit test model script is exhausted.');
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? (response as (request: StructuredModelRequest) => unknown)(request) : response;
  }
}
