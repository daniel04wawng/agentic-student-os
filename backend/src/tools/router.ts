import { z } from 'zod';
import type { ModelService } from '../model/service.js';
import type { ModelMessage } from '../model/provider.js';
import type { ToolPermission, ToolRegistry } from './registry.js';

/** Shape the local model must emit to call a tool. */
export const ToolCallSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.unknown()).default({}),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export type RouterOutcome =
  | { status: 'ok'; tool: string; result: unknown }
  | { status: 'unknown_tool'; tool: string }
  | { status: 'invalid_arguments'; tool: string }
  | { status: 'permission_denied'; tool: string; permission: ToolPermission };

/**
 * On-device tool router (FunctionGemma). Uses the local model to pick a tool,
 * then DETERMINISTICALLY validates the call: the tool must exist, be within the
 * allowed permission set, and its arguments must satisfy the tool's schema.
 * Nothing with side effects executes here — permission is enforced by code, not
 * by trusting the model.
 */
export class FunctionRouter {
  constructor(
    private readonly model: ModelService,
    private readonly registry: ToolRegistry,
    private readonly allowed: ToolPermission[] = ['local_read'],
  ) {}

  async route(query: string): Promise<RouterOutcome> {
    const tools = this.registry.list(this.allowed);
    const messages: ModelMessage[] = [
      {
        role: 'system',
        content:
          'You are a local tool router. Respond ONLY with JSON {"name","arguments"} choosing one of the available tools. Available tools: ' +
          tools.map((t) => `${t.name}(${t.description})`).join('; '),
      },
      { role: 'user', content: query },
    ];

    const call = await this.model.generateStructured({ messages }, ToolCallSchema, {
      // If the model is unavailable/invalid, deterministically decline (no guess).
      fallback: () => ({ name: '__none__', arguments: {} }),
    });

    const tool = this.registry.get(call.name);
    if (!tool) return { status: 'unknown_tool', tool: call.name };

    // Permission is enforced here, regardless of what the model asked for.
    if (!this.allowed.includes(tool.permission)) {
      return { status: 'permission_denied', tool: tool.name, permission: tool.permission };
    }

    const parsed = tool.parameters.safeParse(call.arguments);
    if (!parsed.success) return { status: 'invalid_arguments', tool: tool.name };

    const result = await tool.handler(parsed.data);
    return { status: 'ok', tool: tool.name, result };
  }
}
