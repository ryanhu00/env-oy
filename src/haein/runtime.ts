import { Session } from '../session';
import { SessionManager } from '../sessionManager';
import { TagStore } from '../tags';
import { HaeinClient, HaeinTask } from './client';
import { HaeinSidebarGrouping, HaeinTaskStore, groupTasks } from './tasks';

export interface HaeinTagEditState { task: HaeinTask; value: string; error: string; }

/** Coordinates Haein task data with the PTYs that this Conductor process owns. */
export class HaeinRuntime {
  readonly store: HaeinTaskStore;
  grouping: HaeinSidebarGrouping;
  selected = 0;
  pendingFocusTaskId: string | null;
  tagEdit: HaeinTagEditState | null = null;
  notice = '';
  private readonly sessionsByTaskId = new Map<string, Session>();
  private readonly launchesByTaskId = new Map<string, Promise<Session | null>>();
  private onActivated: ((session: Session) => void) | null = null;

  constructor(readonly client: HaeinClient, private readonly manager: SessionManager, tagStore: TagStore, private readonly render: () => void, focusTaskId?: string) {
    this.grouping = tagStore.haeinSidebarGrouping;
    this.pendingFocusTaskId = focusTaskId ?? null;
    this.store = new HaeinTaskStore(client, () => {
      this.resolvePendingFocus();
      this.render();
    });
    this.tagStore = tagStore;
  }

  private readonly tagStore: TagStore;

  /** Starts polling Haein tasks. */
  start(): void { this.store.start(); }

  /** Stops task polling. */
  stop(): void { this.store.stop(); }

  /** Returns the flattened visible task ordering represented by the Haein sidebar. */
  get tasks(): HaeinTask[] { return groupTasks(this.store.tasks, this.grouping).flatMap((group) => group.tasks); }

  /** Returns the selected task if Haein has delivered any tasks. */
  get selectedTask(): HaeinTask | undefined { return this.tasks[this.selected]; }

  /** Returns a live PTY only if it was started by this Conductor. */
  get selectedSession(): Session | undefined {
    const task = this.selectedTask;
    const session = task ? this.sessionsByTaskId.get(task.id) : undefined;
    return session && !session.exited ? session : undefined;
  }

  /** Registers the terminal-mode transition to perform after focus activates a task PTY. */
  setActivationHandler(handler: (session: Session) => void): void {
    this.onActivated = handler;
  }

  /** Resolves an external focus command now or after the next successful task refresh. */
  focusTask(taskId: string): void {
    this.pendingFocusTaskId = taskId;
    this.resolvePendingFocus();
    this.render();
  }

  /** Selects a task by delta, retaining a valid index through polling updates. */
  move(delta: number): void {
    this.selected = Math.max(0, Math.min(this.tasks.length - 1, this.selected + delta));
    this.render();
  }

  /** Toggles and persists the selected task grouping mode. */
  toggleGrouping(): void {
    this.grouping = this.grouping === 'pipeline_stage' ? 'tag' : 'pipeline_stage';
    this.tagStore.setHaeinSidebarGrouping(this.grouping);
    this.resolvePendingFocus();
    this.notice = `Haein grouping: ${this.grouping === 'tag' ? 'tag' : 'pipeline stage'}`;
    this.render();
  }

  /** Opens a simple editable field initialized from the selected task tag. */
  beginTagEdit(): void {
    const task = this.selectedTask;
    if (!task) { this.notice = 'No Haein task selected'; return; }
    this.tagEdit = { task, value: task.tag, error: '' };
    this.render();
  }

  /** Persists the current text-entry tag then refreshes task rows. */
  async saveTagEdit(): Promise<void> {
    const edit = this.tagEdit;
    if (!edit) return;
    try {
      await this.client.tag(edit.task.id, edit.value.trim());
      this.tagEdit = null;
      await this.store.refresh();
      this.notice = 'Haein task tag updated';
    } catch (error) {
      edit.error = error instanceof Error ? error.message : 'Could not update Haein tag';
    }
    this.render();
  }

  /** Requests Haein launch data and starts a generic PTY only for the selected task. */
  async launchOrAttach(): Promise<Session | null> {
    const task = this.selectedTask;
    if (!task) { this.notice = 'No Haein task selected'; this.render(); return null; }
    return this.launchTask(task);
  }

  private launchTask(task: HaeinTask): Promise<Session | null> {
    const owned = this.sessionsByTaskId.get(task.id);
    if (owned && !owned.exited) {
      this.activate(owned);
      return Promise.resolve(owned);
    }
    const inFlight = this.launchesByTaskId.get(task.id);
    if (inFlight) return inFlight;
    const launch = this.spawnTask(task);
    this.launchesByTaskId.set(task.id, launch);
    void launch.finally(() => {
      if (this.launchesByTaskId.get(task.id) === launch) this.launchesByTaskId.delete(task.id);
    });
    return launch;
  }

  private async spawnTask(task: HaeinTask): Promise<Session | null> {
    try {
      const launch = await this.client.launch(task.id);
      if (launch.taskId !== task.id) throw new Error('Malformed Haein response: launch task_id does not match requested task');
      const session = this.manager.create(launch.cwd, launch.title || task.title, this.tagStore.tags[0], undefined, {
        command: launch.argv,
        onExit: (pid) => { void this.reportExited(task.id, pid); },
        onDevinSessionId: (pid, sessionId) => { void this.reportDevinSession(task.id, pid, sessionId); },
      });
      this.sessionsByTaskId.set(task.id, session);
      try {
        await this.client.reportProcess(task.id, session.pid, launch.sessionId.length > 0 ? launch.sessionId : undefined);
      } catch (error) {
        this.notice = error instanceof Error ? `PTY started but Haein was not notified: ${error.message}` : 'PTY started but Haein was not notified';
      }
      this.activate(session);
      this.render();
      return session;
    } catch (error) {
      this.notice = error instanceof Error ? error.message : 'Could not launch Haein task';
      this.render();
      return null;
    }
  }

  /** Finds the task responsible for a session so renderer and input stay task-centric. */
  taskForSession(session: Session): HaeinTask | undefined {
    for (const [taskId, owned] of this.sessionsByTaskId) if (owned === session) return this.store.tasks.find((task) => task.id === taskId);
    return undefined;
  }

  private async reportExited(taskId: string, pid: number): Promise<void> {
    try { await this.client.reportProcessExited(taskId, pid); }
    catch (error) { this.notice = error instanceof Error ? `Haein exit report failed: ${error.message}` : 'Haein exit report failed'; this.render(); }
  }

  private async reportDevinSession(taskId: string, pid: number, sessionId: string): Promise<void> {
    try { await this.client.reportProcess(taskId, pid, sessionId); }
    catch (error) { this.notice = error instanceof Error ? `Haein Devin session report failed: ${error.message}` : 'Haein Devin session report failed'; this.render(); }
  }

  private activate(session: Session): void {
    this.manager.attach(session);
    this.onActivated?.(session);
  }

  private resolvePendingFocus(): void {
    const tasks = this.tasks;
    const taskId = this.pendingFocusTaskId;
    if (taskId) {
      const index = tasks.findIndex((task) => task.id === taskId);
      if (index >= 0) {
        this.selected = index;
        this.pendingFocusTaskId = null;
        void this.launchTask(tasks[index]);
      }
    }
    this.selected = Math.max(0, Math.min(Math.max(0, tasks.length - 1), this.selected));
  }
}
