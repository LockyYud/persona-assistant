import type {
  CompleteTaskInput,
  CreateReminderInput,
  CreateSubtasksInput,
  CreateTaskInput,
  ListTasksInput,
  UpdateTaskInput,
} from "./schemas.js";
import type { NowTasks, Reminder, Task, TaskWithProgress } from "./domain.js";

export interface TaskService {
  createTask(userId: string, input: CreateTaskInput): Promise<Task>;
  updateTask(userId: string, input: UpdateTaskInput): Promise<Task>;
  completeTask(userId: string, input: CompleteTaskInput): Promise<Task>;
  /** Top-level tasks with their step counts; subtasks are not returned as entries. */
  listTasks(userId: string, input: ListTasksInput): Promise<TaskWithProgress[]>;
  listNowTasks(userId: string): Promise<NowTasks>;
  getTask(userId: string, taskId: string): Promise<Task | null>;
  /** The steps of a task, oldest first. */
  listSubtasks(userId: string, parentTaskId: string): Promise<Task[]>;
  /** Creates several steps under one parent in a single transaction. */
  createSubtasks(userId: string, input: CreateSubtasksInput): Promise<Task[]>;
}

export interface ReminderService {
  createReminder(userId: string, input: CreateReminderInput): Promise<Reminder>;
  cancelReminder(userId: string, reminderId: string): Promise<void>;
}
