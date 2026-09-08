import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeModelProvider } from '../../src/model/provider.js';
import { ModelService } from '../../src/model/service.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { FunctionRouter } from '../../src/tools/router.js';

function registryWith() {
  const registry = new ToolRegistry();
  registry.register({
    name: 'search',
    description: 'search transcripts',
    parameters: z.object({ query: z.string() }),
    permission: 'local_read',
    handler: async (a) => ({ echoed: a.query }),
  });
  registry.register({
    name: 'submit_assignment',
    description: 'submit to canvas',
    parameters: z.object({ id: z.string() }),
    permission: 'remote_side_effect',
    handler: async () => ({ submitted: true }),
  });
  return registry;
}

function routerReturning(text: string): FunctionRouter {
  const model = new ModelService(new FakeModelProvider(() => text));
  return new FunctionRouter(model, registryWith(), ['local_read']);
}

describe('FunctionRouter', () => {
  it('executes an allowed local tool with valid arguments', async () => {
    const router = routerReturning('{"name":"search","arguments":{"query":"mitosis"}}');
    const outcome = await router.route('find mitosis');
    expect(outcome).toEqual({ status: 'ok', tool: 'search', result: { echoed: 'mitosis' } });
  });

  it('denies a tool with side-effect permission (never executes it)', async () => {
    const router = routerReturning('{"name":"submit_assignment","arguments":{"id":"a1"}}');
    const outcome = await router.route('submit my essay');
    expect(outcome).toMatchObject({ status: 'permission_denied', tool: 'submit_assignment' });
  });

  it('rejects invalid arguments without calling the handler', async () => {
    const router = routerReturning('{"name":"search","arguments":{"wrong":1}}');
    expect(await router.route('x')).toMatchObject({ status: 'invalid_arguments', tool: 'search' });
  });

  it('reports an unknown tool', async () => {
    const router = routerReturning('{"name":"does_not_exist","arguments":{}}');
    expect(await router.route('x')).toMatchObject({ status: 'unknown_tool' });
  });

  it('declines safely when the model output is unusable', async () => {
    const router = routerReturning('this is not json');
    expect(await router.route('x')).toMatchObject({ status: 'unknown_tool', tool: '__none__' });
  });
});
