import type {
  CompleteSessionInput,
  CompleteTaskInput,
  CreateReminderInput,
  CreateSubtasksInput,
  CreateTaskInput,
  ListSessionsInput,
  ListTasksInput,
  PlanTodayInput,
  PlanSessionInput,
  SkipSessionInput,
  UpdateTaskInput,
} from "./schemas.js";
import type {
  NowTasks,
  Reminder,
  Task,
  TaskWithProgress,
  WorkSession,
  WorkSessionWithTask,
} from "./domain.js";

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

/**
 * The day-planning surface: which goals get time today, and how much.
 *
 * Separate from TaskService because it answers a different question. A task's
 * steps describe *what* has to be produced; sessions describe *when time was
 * spent*. Nothing here creates or completes tasks.
 */
export interface SessionService {
  /** Idempotent per (task, day) — re-planning revises the existing session. */
  planSession(userId: string, input: PlanSessionInput): Promise<WorkSession>;
  /** Atomically commits a confirmed set of distinct tasks to the user's today. */
  planToday(userId: string, input: PlanTodayInput): Promise<WorkSession[]>;
  completeSession(userId: string, input: CompleteSessionInput): Promise<WorkSession>;
  skipSession(userId: string, input: SkipSessionInput): Promise<WorkSession>;
  /** What was picked for one local day, task included — the widget's "today". */
  listSessionsForDate(userId: string, date: string): Promise<WorkSessionWithTask[]>;
  listSessions(userId: string, input: ListSessionsInput): Promise<WorkSession[]>;
}
