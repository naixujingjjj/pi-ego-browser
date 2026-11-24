import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
/** How many times to retry a rename that Windows refused due to a held file. */
const RENAME_RETRY_LIMIT = 10;
/** Milliseconds to wait between retries. */
const RENAME_RETRY_DELAY_MS = 20;
// save() is synchronous all the way up, so the wait cannot yield to the event
// loop; Atomics.wait at least parks the thread instead of spinning the CPU.
// Worst case (every retry refused) blocks ~200 ms, only under file contention.
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
    Atomics.wait(sleepCell, 0, 0, ms);
}
/**
 * Task spaces emulated as tracked tab sets inside one shared browser profile,
 * the same model PR #134/#202 use on Linux: the profile (and its logins) is
 * shared, ownership and tab membership are host bookkeeping. State persists
 * as JSON so spaces survive across CLI invocations — the browser holds the
 * tabs, this registry holds which tab belongs to which space.
 */
export class TaskSpaceRegistry {
    stateDir;
    statePath;
    nextId;
    currentId;
    spaces;
    constructor(stateDir) {
        this.stateDir = stateDir;
        this.statePath = join(stateDir, "spaces.json");
        this.nextId = 1;
        this.currentId = null;
        this.spaces = new Map();
        this.load();
    }
    list() {
        return [...this.spaces.values()];
    }
    get(id) {
        return this.spaces.get(id);
    }
    current() {
        if (this.currentId === null) {
            return null;
        }
        return this.spaces.get(this.currentId) ?? null;
    }
    create(name) {
        const space = {
            id: this.nextId++,
            name,
            ownership: "agent",
            createdBy: "agent",
            targetIds: [],
            activeTargetId: null,
        };
        this.spaces.set(space.id, space);
        this.save();
        return space;
    }
    select(id) {
        const space = this.spaces.get(id);
        if (!space) {
            return null;
        }
        this.currentId = id;
        this.save();
        return space;
    }
    setOwnership(id, ownership) {
        const space = this.spaces.get(id);
        if (!space) {
            return null;
        }
        space.ownership = ownership;
        this.save();
        return space;
    }
    remove(id) {
        this.spaces.delete(id);
        if (this.currentId === id) {
            this.currentId = null;
        }
        this.save();
    }
    trackTarget(targetId, spaceId = this.currentId) {
        const space = spaceId === null ? null : this.spaces.get(spaceId);
        if (!space || space.targetIds.includes(targetId)) {
            return;
        }
        space.targetIds.push(targetId);
        this.save();
    }
    untrackTarget(targetId) {
        let changed = false;
        for (const space of this.spaces.values()) {
            const index = space.targetIds.indexOf(targetId);
            if (index >= 0) {
                space.targetIds.splice(index, 1);
                changed = true;
            }
            if (space.activeTargetId === targetId) {
                space.activeTargetId = space.targetIds.at(-1) ?? null;
                changed = true;
            }
        }
        if (changed) {
            this.save();
        }
    }
    setActive(targetId, spaceId = this.currentId) {
        const space = spaceId === null ? null : this.spaces.get(spaceId);
        if (!space || !space.targetIds.includes(targetId)) {
            return;
        }
        space.activeTargetId = targetId;
        this.save();
    }
    /** Drop tracked targets the browser no longer reports (closed tabs). */
    pruneTargets(liveTargetIds) {
        const live = new Set(liveTargetIds);
        let changed = false;
        for (const space of this.spaces.values()) {
            const kept = space.targetIds.filter((id) => live.has(id));
            if (kept.length !== space.targetIds.length) {
                space.targetIds = kept;
                changed = true;
            }
            if (space.activeTargetId && !live.has(space.activeTargetId)) {
                space.activeTargetId = kept.at(-1) ?? null;
                changed = true;
            }
        }
        if (changed) {
            this.save();
        }
    }
    load() {
        let raw;
        try {
            raw = readFileSync(this.statePath, "utf8");
        }
        catch {
            return;
        }
        try {
            const state = JSON.parse(raw);
            if (!Number.isFinite(state?.nextId)) {
                return;
            }
            this.nextId = state.nextId;
            this.currentId = state.currentId ?? null;
            for (const space of state.spaces || []) {
                if (Number.isFinite(space?.id) && typeof space?.name === "string") {
                    this.spaces.set(space.id, {
                        ...space,
                        targetIds: Array.isArray(space.targetIds) ? space.targetIds : [],
                        activeTargetId: space.activeTargetId ?? null,
                    });
                }
            }
        }
        catch {
            // A corrupt state file starts fresh instead of blocking the host.
        }
    }
    save() {
        const state = {
            nextId: this.nextId,
            currentId: this.currentId,
            spaces: this.list(),
        };
        mkdirSync(this.stateDir, { recursive: true });
        // Atomic replace so a failed write leaves the previous state valid.
        const tempPath = `${this.statePath}.${process.pid}.tmp`;
        writeFileSync(tempPath, JSON.stringify(state, null, 2));
        // Windows refuses to rename onto a file that another process holds open
        // (EPERM / EBUSY). Retry briefly, then clean up the scratch file and
        // rethrow — the same pattern as atomic-write.mjs on Linux.
        for (let attempt = 0;; attempt += 1) {
            try {
                renameSync(tempPath, this.statePath);
                return;
            }
            catch (error) {
                const code = error.code;
                const transient = code === "EPERM" || code === "EBUSY";
                if (!transient || attempt >= RENAME_RETRY_LIMIT) {
                    try {
                        rmSync(tempPath, { force: true });
                    }
                    catch {
                        // best-effort cleanup; original error is the one worth surfacing
                    }
                    throw error;
                }
                sleepSync(RENAME_RETRY_DELAY_MS);
            }
        }
    }
}
