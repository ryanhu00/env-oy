"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HaeinTaskStore = exports.PIPELINE_STAGES = void 0;
exports.groupTasks = groupTasks;
exports.PIPELINE_STAGES = ['Running', 'Monitoring', 'Needs Attention', 'Ready to Merge', 'Merged'];
/** Groups Haein task rows into stable pipeline or user-tag sidebar sections. */
function groupTasks(tasks, grouping) {
    const groups = new Map();
    for (const task of tasks) {
        const label = grouping === 'tag' ? task.tag.trim() || 'Untagged' : task.stage.trim() || 'Unknown';
        const existing = groups.get(label);
        if (existing)
            existing.push(task);
        else
            groups.set(label, [task]);
    }
    const stagePosition = new Map(exports.PIPELINE_STAGES.map((stage, index) => [stage, index]));
    return [...groups.entries()]
        .sort(([a], [b]) => grouping === 'tag' ? a.localeCompare(b) : (stagePosition.get(a) ?? exports.PIPELINE_STAGES.length) - (stagePosition.get(b) ?? exports.PIPELINE_STAGES.length) || a.localeCompare(b))
        .map(([label, grouped]) => ({ label, tasks: grouped.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)) }));
}
/** Polls Haein tasks while retaining the last valid rows if an update fails. */
class HaeinTaskStore {
    client;
    onUpdate;
    tasks = [];
    notice = '';
    timer = null;
    polling = false;
    constructor(client, onUpdate) {
        this.client = client;
        this.onUpdate = onUpdate;
    }
    /** Starts immediate and two-second task polling. */
    start() {
        void this.refresh();
        this.timer = setInterval(() => { void this.refresh(); }, 2000);
    }
    /** Stops later polling without modifying the last available task data. */
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    /** Fetches tasks once, converting service failures into a persistent UI notice. */
    async refresh() {
        if (this.polling)
            return;
        this.polling = true;
        try {
            const result = await this.client.listTasks();
            this.tasks = result.tasks;
            this.notice = '';
        }
        catch (error) {
            this.notice = error instanceof Error ? error.message : 'Haein task refresh failed';
        }
        finally {
            this.polling = false;
            this.onUpdate();
        }
    }
}
exports.HaeinTaskStore = HaeinTaskStore;
