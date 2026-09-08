import type { ZodType } from 'zod';

/**
 * Permission tiers for tools the on-device model may call. FunctionGemma is
 * allowed ONLY local read tools; anything with side effects (writes, remote
 * calls) must go through the main planner with explicit approval, never the
 * local router.
 */
export type ToolPermission = 'local_read' | 'local_write' | 'remote_side_effect';

export interface Tool<A = unknown, R = unknown> {
  name: string;
  description: string;
  parameters: ZodType<A>;
  permission: ToolPermission;
  handler: (args: A) => Promise<R>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register<A, R>(tool: Tool<A, R>): void {
    this.tools.set(tool.name, tool as unknown as Tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Tools exposable to the model given an allowed-permission set. */
  list(allowed: ToolPermission[]): Tool[] {
    return [...this.tools.values()].filter((t) => allowed.includes(t.permission));
  }
}
