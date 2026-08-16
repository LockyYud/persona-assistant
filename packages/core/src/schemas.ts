import { z } from "zod";

export const taskStatusSchema = z.enum(["open", "in_progress", "done", "cancelled"]);
export const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

export const createTaskInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  priority: taskPrioritySchema.default("medium"),
  dueAt: z.string().datetime().optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const updateTaskInputSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  dueAt: z.string().datetime().nullable().optional(),
});
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

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
