import { HaeinClient, HaeinTask } from './client';

export type HaeinSidebarGrouping = 'tag' | 'pipeline_stage';
export const PIPELINE_STAGES = ['Running', 'Monitoring', 'Needs Attention', 'Ready to Merge', 'Merged'] as const;

export interface HaeinTaskGroup {
  label: string;
  tasks: HaeinTask[];
}

/** Groups Haein task rows into stable pipeline or user-tag sidebar sections. */
export function groupTasks(tasks: readonly HaeinTask[], grouping: HaeinSidebarGrouping): HaeinTaskGroup[] {
  const groups = new Map<string, HaeinTask[]>();
  for (const task of tasks) {
    const label = grouping === 'tag' ? task.tag.trim() || 'Untagged' : task.stage.trim() || 'Unknown';
    const existing = groups.get(label);
    if (existing) existing.push(task);
    else groups.set(label, [task]);
  }
  const stagePosition = new Map<string, number>(PIPELINE_STAGES.map((stage, index): [string, number] => [stage, index]));
  return [...groups.entries()]
    .sort(([a], [b]) => grouping === 'tag' ? a.localeCompare(b) : (stagePosition.get(a) ?? PIPELINE_STAGES.length) - (stagePosition.get(b) ?? PIPELINE_STAGES.length) || a.localeCompare(b))
    .map(([label, grouped]) => ({ label, tasks: grouped.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)) }));
}

/** Polls Haein tasks while retaining the last valid rows if an update fails. */
export class HaeinTaskStore {
  tasks: HaeinTask[] = [];
  notice = '';
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(private readonly client: HaeinClient, private readonly onUpdate: () => void) {}

  /** Starts immediate and two-second task polling. */
  start(): void {
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, 2000);
  }

  /** Stops later polling without modifying the last available task data. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fetches tasks once, converting service failures into a persistent UI notice. */
  async refresh(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const result = await this.client.listTasks();
      this.tasks = result.tasks;
      this.notice = '';
    } catch (error) {
      this.notice = error instanceof Error ? error.message : 'Haein task refresh failed';
    } finally {
      this.polling = false;
      this.onUpdate();
    }
  }
}
