import { deriveIdempotencyKey } from '@student-os/shared';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SqlClient } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import type { ModelMessage } from '../model/provider.js';
import type { ModelService } from '../model/service.js';

export const STUDENT_PLAN = 'student.plan';
export const CAPABILITY_REQUESTED = 'capability.requested';

/** Capabilities the planner may select (executed by later PRs). */
export const CAPABILITIES = [
  'plan_assignment',
  'generate_assignment',
  'prepare_class',
  'summarize_course',
  'resolve_context',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const PlanStepSchema = z.object({
  capability: z.enum(CAPABILITIES),
  target_id: z.string().optional(),
  rationale: z.string().default(''),
});
export const PlanSchema = z.object({
  summary: z.string().default(''),
  steps: z.array(PlanStepSchema).default([]),
});
export type Plan = z.infer<typeof PlanSchema>;

export interface WorldStateAssignment {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
}

export interface WorldState {
  assignments: WorldStateAssignment[];
}

/** Deterministic inspection of the world state the planner reasons over. */
export async function gatherWorldState(db: SqlClient, courseId?: string): Promise<WorldState> {
  const { rows } = await db.query<WorldStateAssignment>(
    `SELECT id, title, status,
            to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS due_at
     FROM assignments
     WHERE ($1::uuid IS NULL OR course_id = $1::uuid)
       AND status NOT IN ('submitted', 'archived')
     ORDER BY due_at NULLS LAST`,
    [courseId ?? null],
  );
  return { assignments: rows };
}

/**
 * Deterministic fallback plan (rule-based). Used when the model is unavailable
 * or returns invalid output, so planning never silently stalls.
 */
export function deterministicPlan(state: WorldState): Plan {
  const steps = state.assignments.flatMap((a): Plan['steps'] => {
    if (a.status === 'context_ready') {
      return [{ capability: 'generate_assignment', target_id: a.id, rationale: 'context is ready' }];
    }
    if (a.status === 'not_started' && a.due_at) {
      return [{ capability: 'plan_assignment', target_id: a.id, rationale: 'upcoming, needs a plan' }];
    }
    return [];
  });
  return { summary: `${steps.length} action(s) from world state`, steps };
}

/** Generate a plan from the current world state (model + deterministic fallback). */
export async function generatePlan(
  db: SqlClient,
  model: ModelService,
  courseId?: string,
): Promise<Plan> {
  const state = await gatherWorldState(db, courseId);
  const messages: ModelMessage[] = [
    {
      role: 'system',
      content:
        'You are a student productivity planner. Given the world state, return JSON ' +
        '{"summary","steps":[{"capability","target_id","rationale"}]}. Capabilities: ' +
        CAPABILITIES.join(', ') + '.',
    },
    { role: 'user', content: JSON.stringify(state) },
  ];
  return model.generateStructured({ messages }, PlanSchema, {
    fallback: () => deterministicPlan(state),
  });
}

export interface RunPlanResult {
  planId: string;
  plan: Plan;
}

/**
 * Proactive planning run: generate a plan and emit `student.plan` plus a
 * `capability.requested` event per selected step (executed by later PRs).
 */
export async function runPlan(
  db: SqlClient,
  bus: EventBus,
  model: ModelService,
  courseId?: string,
): Promise<RunPlanResult> {
  const plan = await generatePlan(db, model, courseId);
  const planId = randomUUID();
  const traceId = randomUUID();

  await bus.publish({
    name: STUDENT_PLAN,
    occurred_at: new Date().toISOString(),
    idempotency_key: deriveIdempotencyKey(['student', 'plan', planId]),
    trace_id: traceId,
    source: 'system',
    subject_type: 'plan',
    payload: { plan_id: planId, course_id: courseId ?? null, plan },
  });

  for (let i = 0; i < plan.steps.length; i += 1) {
    const step = plan.steps[i]!;
    await bus.publish({
      name: CAPABILITY_REQUESTED,
      occurred_at: new Date().toISOString(),
      idempotency_key: deriveIdempotencyKey(['capability', planId, String(i)]),
      trace_id: traceId,
      source: 'system',
      subject_type: 'capability',
      subject_id: step.target_id,
      payload: { plan_id: planId, ...step },
    });
  }

  return { planId, plan };
}
