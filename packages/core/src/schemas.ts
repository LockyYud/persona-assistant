import { z } from "zod";

export const taskStatusSchema = z.enum(["open", "in_progress", "done", "cancelled"]);
export const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export const taskTypeSchema = z.enum(["work", "personal", "chore"]);

export const createTaskInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  priority: taskPrioritySchema.default("medium"),
  type: taskTypeSchema.default("personal"),
  dueAt: z.string().datetime().optional(),
  /** Makes the new task a step of an existing one. */
  parentTaskId: z.string().uuid().optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const updateTaskInputSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  type: taskTypeSchema.optional(),
  dueAt: z.string().datetime().nullable().optional(),
  /** Pass null to promote a subtask back to a top-level task. */
  parentTaskId: z.string().uuid().nullable().optional(),
});
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

/** Read-only: asks the LLM to propose steps, creates nothing. */
export const proposeTaskBreakdownInputSchema = z.object({
  taskId: z.string().uuid(),
  /** Anything the user said that should steer the breakdown. */
  context: z.string().max(2000).optional(),
});
export type ProposeTaskBreakdownInput = z.infer<typeof proposeTaskBreakdownInputSchema>;

/**
 * Creates the steps. Deliberately takes explicit titles rather than a task id
 * to re-derive them from: this tool needs user confirmation, and the approval
 * payload must be exactly the list the user was shown — re-running a
 * generation step at approval time could produce different steps than the
 * ones they agreed to.
 */
export const createSubtasksInputSchema = z.object({
  parentTaskId: z.string().uuid(),
  titles: z.array(z.string().min(1).max(200)).min(1).max(20),
});
export type CreateSubtasksInput = z.infer<typeof createSubtasksInputSchema>;

export const completeTaskInputSchema = z.object({
  taskId: z.string().uuid(),
});
export type CompleteTaskInput = z.infer<typeof completeTaskInputSchema>;

export const listTasksInputSchema = z.object({
  status: taskStatusSchema.optional(),
});
export type ListTasksInput = z.infer<typeof listTasksInputSchema>;

export const createReminderInputSchema = z.object({
  taskId: z.string().uuid(),
  message: z.string().min(1).max(500),
  timezone: z.string().min(1).default("Asia/Bangkok"),
  rrule: z.string().optional(),
  nextRunAt: z.string().datetime(),
});
export type CreateReminderInput = z.infer<typeof createReminderInputSchema>;

export const chatInputSchema = z.object({
  userId: z.string().uuid(),
  message: z.string().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
});
export type ChatInput = z.infer<typeof chatInputSchema>;

export const internalTickSignatureHeaders = z.object({
  "x-signature": z.string(),
  "x-timestamp": z.string(),
});
