import { z } from 'zod';
import { validDate, validZone } from './time.ts';

const date = z.string().refine(validDate, 'Invalid calendar date');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const zone = z.string().refine(validZone, 'Invalid timezone');
const taskId = z.string().regex(/^[a-f0-9]{32}$/);

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create_task'), title: z.string().trim().min(1).max(180), due_date: date, due_time: time.nullable(), timezone: zone, source: z.string().min(1).max(1000) }).strict(),
  z.object({ type: z.literal('update_task'), task_id: taskId, title: z.string().trim().min(1).max(180), due_date: date, due_time: time.nullable(), timezone: zone }).strict(),
  z.object({ type: z.literal('complete_task'), task_id: taskId }).strict(),
  z.object({ type: z.literal('reminder'), task_id: z.string().regex(/^(?:[a-f0-9]{32}|new:\d{1,2})$/).nullable(), text: z.string().min(1).max(500), date, time, timezone: zone }).strict(),
  z.object({ type: z.literal('briefing'), time, timezone: zone, days_ahead: z.number().int().min(0).max(30), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('preference'), key: z.enum(['finish_days_early', 'quiet_start', 'quiet_end', 'timezone']), value: z.string().max(100) }).strict()
]);

export const PlanSchema = z.object({
  reply: z.string().min(1).max(2500),
  actions: z.array(ActionSchema).max(30),
  needs_clarification: z.boolean()
}).strict().superRefine((plan, ctx) => {
  if (plan.needs_clarification && plan.actions.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Clarification must not include executable actions.' });
});

export type Action = z.infer<typeof ActionSchema>;
export type Plan = z.infer<typeof PlanSchema>;

// JSON Schema sent to the model is intentionally simple; Zod validates the result independently.
export const planJsonSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string' }, needs_clarification: { type: 'boolean' },
    actions: { type: 'array', items: { type: 'object', properties: {
      type: { type: 'string', enum: ['create_task', 'update_task', 'complete_task', 'reminder', 'briefing', 'preference'] },
      title: { type: 'string' }, due_date: { type: 'string' }, due_time: { type: ['string', 'null'] },
      timezone: { type: 'string' }, source: { type: 'string' }, task_id: { type: ['string', 'null'] },
      text: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' },
      days_ahead: { type: 'integer' }, enabled: { type: 'boolean' }, key: { type: 'string' }, value: { type: 'string' }
    }, required: ['type'] } }
  }, required: ['reply', 'needs_clarification', 'actions']
};

export function describeAction(action: Action): string {
  switch (action.type) {
    case 'create_task': return `Add: ${action.title} — ${action.due_date}${action.due_time ? ' ' + action.due_time : ' (all day)'} [${action.timezone}]\nSource: ${action.source}`;
    case 'update_task': return `Update: ${action.title} — ${action.due_date}${action.due_time ? ' ' + action.due_time : ' (all day)'} [${action.timezone}]\nExisting reminders keep their original times unless separately changed.`;
    case 'complete_task': return `Mark task ${action.task_id.slice(0, 8)} complete (calendar event stays).`;
    case 'reminder': return `Reminder: ${action.text} — ${action.date} ${action.time} [${action.timezone}]`;
    case 'briefing': return action.enabled ? `Daily briefing: ${action.time} [${action.timezone}], unfinished tasks through ${action.days_ahead} days ahead.` : 'Disable daily briefing.';
    case 'preference': return `Preference: ${action.key} = ${action.value}`;
  }
}
