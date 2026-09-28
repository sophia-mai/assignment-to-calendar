import { z } from 'zod';
import { validDate, validZone, formatDeadline, formatInterval, formatDate, formatClock, localInstant, stableId } from './time.ts';

const date = z.string().refine(validDate, 'Invalid calendar date');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const zone = z.string().refine(validZone, 'Invalid timezone');
const taskId = z.string().regex(/^[a-f0-9]{32}$/);

const eventTarget = { query: z.string().max(180), date_from: date, date_to: date, timezone: zone, event_ref: taskId.nullable(), recurrence_scope: z.enum(['occurrence', 'series']).nullable() };

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rename_event'), ...eventTarget, title: z.string().trim().min(1).max(180) }).strict(),
  z.object({ type: z.literal('reschedule_event'), ...eventTarget, date, time, end_date: date, end_time: time }).strict(),
  z.object({ type: z.literal('delete_event'), ...eventTarget }).strict(),
  z.object({ type: z.literal('create_event'), title: z.string().trim().min(1).max(180), date, time, end_date: date, end_time: time, timezone: zone, description: z.string().max(4000), location: z.string().max(1000).nullable() }).strict(),
  z.object({ type: z.literal('find_events'), query: z.string().max(180), date_from: date, date_to: date, timezone: zone }).strict(),
  z.object({ type: z.literal('check_conflicts'), date: date, time, end_date: date, end_time: time, timezone: zone }).strict(),
  z.object({ type: z.literal('edit_event'), ...eventTarget, append_description: z.string().trim().min(1).max(4000).nullable(), location: z.string().trim().min(1).max(1000).nullable() }).strict(),
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

export async function createdTaskId(action: Extract<Action, { type: 'create_task' }>) {
  return stableId(JSON.stringify([action.title.trim().toLowerCase().replace(/\s+/g, ' '), action.due_date, action.due_time, action.timezone]));
}

// JSON Schema sent to the model is intentionally simple; Zod validates the result independently.
const planSchemaTemplate = {
  type: 'object',
  properties: {
    reply: { type: 'string' }, needs_clarification: { type: 'boolean' },
    actions: { type: 'array', items: { type: 'object', properties: {
      type: { type: 'string', enum: ['create_event', 'create_task', 'update_task', 'complete_task', 'reminder', 'briefing', 'preference', 'find_events', 'check_conflicts', 'edit_event'] },
      description: { type: 'string' },
      query: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' }, end_date: { type: 'string' }, end_time: { type: 'string' },
      event_ref: { type: ['string', 'null'] }, recurrence_scope: { type: ['string', 'null'], enum: ['occurrence', 'series', null] }, append_description: { type: ['string', 'null'] }, location: { type: ['string', 'null'] },
      title: { type: 'string' }, due_date: { type: 'string' }, due_time: { type: ['string', 'null'] },
      timezone: { type: 'string' }, source: { type: 'string' }, task_id: { type: ['string', 'null'] },
      text: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' },
      days_ahead: { type: 'integer' }, enabled: { type: 'boolean' }, key: { type: 'string' }, value: { type: 'string' }
    }, required: ['type'] } }
  }, required: ['reply', 'needs_clarification', 'actions']
};

// Each alternative has exactly the fields its runtime action requires. A flat
// bag of optional fields allowed Gemini to omit times and mix unrelated actions.
const actionFields: Record<Action['type'], string[]> = {
  rename_event: ['query', 'date_from', 'date_to', 'timezone', 'event_ref', 'recurrence_scope', 'title'],
  reschedule_event: ['query', 'date_from', 'date_to', 'timezone', 'event_ref', 'recurrence_scope', 'date', 'time', 'end_date', 'end_time'],
  delete_event: ['query', 'date_from', 'date_to', 'timezone', 'event_ref', 'recurrence_scope'],
  create_event: ['title', 'date', 'time', 'end_date', 'end_time', 'timezone', 'description', 'location'],
  create_task: ['title', 'due_date', 'due_time', 'timezone', 'source'],
  update_task: ['task_id', 'title', 'due_date', 'due_time', 'timezone'],
  complete_task: ['task_id'],
  reminder: ['task_id', 'text', 'date', 'time', 'timezone'],
  briefing: ['time', 'timezone', 'days_ahead', 'enabled'],
  preference: ['key', 'value'],
  find_events: ['query', 'date_from', 'date_to', 'timezone'],
  check_conflicts: ['date', 'time', 'end_date', 'end_time', 'timezone'],
  edit_event: ['query', 'date_from', 'date_to', 'timezone', 'event_ref', 'recurrence_scope', 'append_description', 'location']
};
const fields: Record<string, unknown> = planSchemaTemplate.properties.actions.items.properties;
export const planJsonSchema = {
  ...planSchemaTemplate,
  additionalProperties: false,
  properties: {
    ...planSchemaTemplate.properties,
    // Zod enforces the 30-action cap; a provider-side array bound makes this union
    // exceed Gemini 2.5's constrained-decoding state budget.
    actions: { type: 'array', items: { anyOf: Object.entries(actionFields).map(([type, names]) => ({
      type: 'object', additionalProperties: false,
      properties: { type: { type: 'string', enum: [type] }, ...Object.fromEntries(names.map(name => [name, name === 'task_id' && type !== 'reminder' ? { type: 'string' } : fields[name]])) },
      required: ['type', ...names]
    })) } }
  }
};

export function describeAction(action: Action, displayZone?: string): string {
  switch (action.type) {
    case 'rename_event': return 'Rename matching event to: ' + action.title;
    case 'reschedule_event': return 'Reschedule matching event';
    case 'delete_event': return 'Delete matching event';
    case 'create_event': return `Schedule: ${action.title} — ${formatInterval(localInstant(action.date, action.time, action.timezone), localInstant(action.end_date, action.end_time, action.timezone), displayZone ?? action.timezone)}\nCalendar: Assignment Planner (reserves busy time)${action.location ? '\nLocation: ' + action.location : ''}${action.description ? '\nDescription: ' + action.description : ''}\nConflicts checked again when you confirm. No guests will be invited.`;
    case 'find_events': return `Search events: ${action.query || 'all'} (${formatDate(action.date_from)} through ${formatDate(action.date_to)})`;
    case 'check_conflicts': return `Check availability: ${formatInterval(localInstant(action.date, action.time, action.timezone), localInstant(action.end_date, action.end_time, action.timezone), displayZone ?? action.timezone)}`;
    case 'edit_event': return `Update matching event${action.append_description ? '\nAppend note: ' + action.append_description : ''}${action.location ? '\nSet location: ' + action.location : ''}`;
    case 'create_task': return `Add: ${action.title} — ${formatDeadline(action.due_date, action.due_time, action.timezone, displayZone)}\nSource: ${action.source}`;
    case 'update_task': return `Update: ${action.title} — ${formatDeadline(action.due_date, action.due_time, action.timezone, displayZone)}\nExisting reminders keep their original times unless separately changed.`;
    case 'complete_task': return `Mark task ${action.task_id.slice(0, 8)} complete (calendar event stays).`;
    case 'reminder': return `Reminder: ${action.text} — ${formatDeadline(action.date, action.time, action.timezone, displayZone)}`;
    case 'briefing': return action.enabled ? `Daily briefing: ${formatClock(action.time)} [${action.timezone}], unfinished tasks through ${action.days_ahead} days ahead.` : 'Disable daily briefing.';
    case 'preference': if (action.key === 'timezone') return `Set default timezone: ${action.value}\nApplies to future requests, displayed times, and quiet hours. Existing events, reminders, daily briefings, and pending proposals keep their scheduled times.`; return `Preference: ${action.key} = ${action.value}`;
  }
}
