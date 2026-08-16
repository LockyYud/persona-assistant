import type {
  CompleteTaskInput,
  CreateReminderInput,
  CreateTaskInput,
  ListTasksInput,
  UpdateTaskInput,
} from "./schemas.js";
import type { Reminder, Task } from "./domain.js";

export interface TaskService {
  createTask(userId: string, input: CreateTaskInput): Promise<Task>;
  updateTask(userId: string, input: UpdateTaskInput): Promise<Task>;
  completeTask(userId: string, input: CompleteTaskInput): Promise<Task>;
  listTasks(userId: string, input: ListTasksInput): Promise<Task[]>;
  getTask(userId: string, taskId: string): Promise<Task | null>;
}

export interface ReminderService {
  createReminder(userId: string, input: CreateReminderInput): Promise<Reminder>;
  cancelReminder(userId: string, reminderId: string): Promise<void>;
}
