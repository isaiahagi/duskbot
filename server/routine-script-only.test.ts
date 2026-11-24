import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoutineProbe } from "../shared/routines.ts";
import { CHECK_BOOT_HOLD_MS, CHECK_RUNS_PER_DAY, checkRunsLeft, type RoutineCheckContext } from "./routine-check-pacing.ts";
import { createRoutineProbes } from "./routine-probe.ts";
import { scriptRunOptions, SCRIPT_TIMEOUT_MS, type ScriptResult } from "./routine-script.ts";
import { ROUTINE_RESTARTED, RoutineManager, type Routine, type RoutineChecks, type RoutineManagerOptions, type RoutineRun } from "./routines.ts";

const HOUR = 60 * 60_000;
const START = new Date(2026, 10, 20, 9, 0, 0).getTime();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "dusk-script-only-")); dirs.push(dir); return dir; };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

const postingProbe: RoutineProbe = { kind: "script", url: "", command: "report", post: true };
const posting = { id: "r1", probe: postingProbe, checks: ["probe"], prompt: "p" } as Routine;

function probesPrinting(result: () => ScriptResult) {
  return createRoutineProbes({ dataDir: tempDir(), now: () => START, script: async () => result() });
}

describe("a posting script check", () => {
  it("starts a run that carries the output as printed, even when it is the same as last time", async () => {
    const probes = probesPrinting(() => ({ ok: true, output: "  BTC 97,000\nETH 3,400\n{\"wakeAgent\": true}\n" }));
    for (const id of ["run-1", "run-2"]) {
      const result = await probes.check(posting, { manual: false });
      expect(result.run?.post).toBe("BTC 97,000\nETH 3,400");
      probes.settled({ id, status: "completed", checkKey: result.run!.key } as never);
    }
  });

  it("holds the next read while a run is in flight", async () => {
    const probes = probesPrinting(() => ({ ok: true, output: "news" }));
    expect((await probes.check(posting, { manual: false })).run?.post).toBe("news");
    expect(await probes.check(posting, { manual: false })).toEqual({ held: true });
  });

  it("is quiet on empty output and on {\"wakeAgent\": false}", async () => {
    for (const output of ["", "  \n", "nothing today\n{\"wakeAgent\": false}"]) {
      expect(await probesPrinting(() => ({ ok: true, output })).check(posting, { manual: false })).toEqual({});
    }
  });

  it("starts a run that fails with the script's error when the script fails, never quiet", async () => {
    const probes = probesPrinting(() => ({ ok: false, error: "The script stopped with exit code 2." }));
    expect((await probes.check(posting, { manual: false })).run?.post).toEqual({ error: "The script stopped with exit code 2." });
  });

  it("runs the script inside the fence in a test run", async () => {
    const asked: boolean[] = [];
    const probes = createRoutineProbes({ dataDir: tempDir(), now: () => START, script: async (_routine, _command, dryRun) => { asked.push(dryRun); return { ok: true, output: "x" }; } });
    await probes.check({ ...posting, probe: { ...postingProbe, access: "full" } }, { manual: true, dryRun: true });
    expect(asked).toEqual([true]);
  });
});

describe("a run with a post", () => {
  function manager(options: Partial<RoutineManagerOptions> = {}, post: string | { error: string } = "Line one\n\nLine two") {
    let now = START;
    const startTurn = vi.fn(async () => {});
    const contexts: RoutineCheckContext[] = [];
    const checks: RoutineChecks = { check: async (_routine, context) => { contexts.push(context); return { run: { key: "prb-k", prompt: "p", post } }; }, release: () => {}, settled: () => {} };
    const file = join(tempDir(), "routines.json");
    const routines = new RoutineManager({
      file, now: () => now, botState: () => "ready",
      createTask: () => ({ threadId: "thread-1" }), startTurn, checks, ...options,
    });
    const routine = routines.create({ name: "Prices", prompt: "p", botId: "b", schedule: { type: "interval", everyMinutes: 60, anchorAt: START + HOUR }, probe: { kind: "script", url: "", command: "report" } });
    return {
      routines, startTurn, contexts, routine, file, now: () => now,
      async hour() { now += CHECK_BOOT_HOLD_MS + HOUR; await routines.tick(); await settle(); },
    };
  }

  it("posts the text as the reply and completes with no AI turn", async () => {
    const posts: string[] = [];
    const h = manager({ postReply: (_botId, threadId, text, run) => { posts.push(`${threadId}|${text}|${run.status}`); } });
    await h.hour();
    expect(posts).toEqual(["thread-1|Line one\n\nLine two|completed"]);
    expect(h.startTurn).not.toHaveBeenCalled();
    expect(h.routines.listRuns()[0]).toMatchObject({ status: "completed", output: "Line one\n\nLine two" });
  });

  it.each(["curl: (28) Operation timed out", "401 Unauthorized"])("fails on the script's error %j as it is, never retried into a turn", async (error) => {
    const postReply = vi.fn(), onRunFailed = vi.fn();
    const h = manager({ postReply, onRunFailed }, { error });
    await h.hour();
    await h.hour();
    expect(postReply).not.toHaveBeenCalled();
    expect(h.startTurn).not.toHaveBeenCalled();
    expect(h.routines.listRuns()[0]).toMatchObject({ status: "failed", error });
    expect(onRunFailed.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("fails a run whose text a restart lost, with no AI turn", async () => {
    const h = manager({ postReply: () => {} });
    await h.hour();
    h.routines.close();
    const saved = JSON.parse(readFileSync(h.file, "utf8")) as { runs: RoutineRun[] };
    Object.assign(saved.runs[0]!, { status: "running", output: undefined, finishedAt: undefined });
    writeFileSync(h.file, JSON.stringify(saved));
    let now = h.now();
    const startTurn = vi.fn(async () => {});
    const restarted = new RoutineManager({ file: h.file, now: () => now, botState: () => "ready", createTask: () => ({ threadId: "thread-2" }), startTurn, postReply: () => {} });
    now += 60_000;
    await restarted.tick();
    await settle();
    expect(startTurn).not.toHaveBeenCalled();
    expect(restarted.listRuns().find((run) => run.id === saved.runs[0]!.id)).toMatchObject({ status: "failed", error: ROUTINE_RESTARTED });
    restarted.close();
  });

  it("tells the check a test run is one", async () => {
    const h = manager({ postReply: () => {} });
    h.routines.runNow(h.routine.id, undefined, true);
    await h.hour();
    expect(h.contexts.filter((context) => context.dryRun)).toEqual([expect.objectContaining({ manual: true })]);
  });

  it("fails with a clear message when the server cannot post", async () => {
    const h = manager();
    await h.hour();
    expect(h.startTurn).not.toHaveBeenCalled();
    expect(h.routines.listRuns()[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/cannot post a script's output/) });
  });
});

describe("the checks' daily AI runs", () => {
  it("never counts a script-only run", () => {
    const runs = (scriptOnly: boolean) => Array.from({ length: 30 }, (_, i) => ({ routineId: "r1", checkKey: `prb-${i}`, manual: false, createdAt: START - i * 30 * 60_000, ...(scriptOnly ? { scriptOnly: true } : {}) }) as RoutineRun);
    expect(checkRunsLeft(runs(true), "r1", START)).toBe(CHECK_RUNS_PER_DAY);
    expect(checkRunsLeft(runs(false), "r1", START)).toBe(0);
  });
});

describe("how a script check runs", () => {
  it("leaves the fence only with access full outside a test run, and a posting script takes the routine's time limit", () => {
    const full = { ...postingProbe, access: "full" as const };
    expect(scriptRunOptions({ probe: postingProbe })).toEqual({ sandbox: true, timeoutMs: SCRIPT_TIMEOUT_MS });
    expect(scriptRunOptions({ probe: full, timeoutMinutes: 5 })).toEqual({ sandbox: false, timeoutMs: 5 * 60_000 });
    expect(scriptRunOptions({ probe: full, timeoutMinutes: 5 }, true)).toEqual({ sandbox: true, timeoutMs: 5 * 60_000 });
    expect(scriptRunOptions({ probe: { kind: "script", url: "", command: "x" }, timeoutMinutes: 5 })).toEqual({ sandbox: true, timeoutMs: SCRIPT_TIMEOUT_MS });
  });
});
