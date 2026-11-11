import { describe, expect, it } from "vitest";
import { applyProbe, buildSiteReport, dailyLine, emptySiteWatchState, postSiteReport, probeSite, type SiteProbe } from "./site-watcher.js";

const probe = (state: SiteProbe["state"], at: string): SiteProbe => ({ at, state, http: state === "ok" ? 200 : 503, ms: 100, version: "abc" });

describe("site watcher", () => {
  it("opens an episode on the first bad probe and closes it with its length on the next good one", () => {
    let s = emptySiteWatchState();
    let r = applyProbe(s, probe("ok", "2026-11-11T08:00:00Z"));
    expect(r.lines).toEqual([]);
    r = applyProbe(r.state, probe("db_stall", "2026-11-11T08:10:00Z"));
    expect(r.lines[0]).toContain("stall started: db_stall at 2026-11-11T08:10:00Z");
    r = applyProbe(r.state, probe("db_stall", "2026-11-11T08:20:00Z"));
    expect(r.lines).toEqual([]);
    expect(r.state.current?.probes).toBe(2);
    r = applyProbe(r.state, probe("ok", "2026-11-11T09:40:00Z"));
    expect(r.lines[0]).toContain("lasted about 90 min (2 probes)");
    expect(r.state.current).toBeNull();
    expect(r.state.history).toHaveLength(1);
    s = r.state;
    expect(s.history[0]?.endedAt).toBe("2026-11-11T09:40:00Z");
  });

  it("writes the daily line at most once a day, counting finished stalls in the last 24 h", () => {
    let s = emptySiteWatchState();
    s = applyProbe(s, probe("no_answer", "2026-11-11T08:00:00Z")).state;
    s = applyProbe(s, probe("ok", "2026-11-11T08:30:00Z")).state;
    const line = dailyLine(s, "2026-11-11T09:00:00Z");
    expect(line).toContain("1 finished stalls, 30 min total, longest 30 min, now ok");
    s.lastDailyAt = "2026-11-11T09:00:00Z";
    expect(dailyLine(s, "2026-11-11T20:00:00Z")).toBeNull();
    expect(dailyLine(s, "2026-11-12T09:00:01Z")).not.toBeNull();
  });

  it("classifies the health answer and never throws", async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
    expect((await probeSite("http://x", answer(200, { checks: { database: "ok" }, version: "v" }))).state).toBe("ok");
    expect((await probeSite("http://x", answer(503, { checks: { database: "timeout" } }))).state).toBe("db_stall");
    expect((await probeSite("http://x", answer(500, {}))).state).toBe("site_error");
    expect((await probeSite("http://x", (async () => { throw new Error("down"); }) as typeof fetch)).state).toBe("no_answer");
  });

  it("builds a report the site route accepts and posts it with the variable without logging it", async () => {
    let s = emptySiteWatchState();
    s = applyProbe(s, probe("db_stall", "2026-11-11T08:00:00Z")).state;
    s = applyProbe(s, probe("ok", "2026-11-11T08:30:00Z")).state;
    const report = buildSiteReport(s, "2026-11-11T09:00:00Z");
    expect(report.agents[0]?.name).toBe("Site watcher");
    expect(report.runs).toEqual([{ agent: "Site watcher", status: "stall db_stall", finished_at: "2026-11-11T08:30:00Z" }]);
    const logs: string[] = [];
    let auth = "";
    const f = (async (_u: unknown, init?: RequestInit) => {
      auth = String((init?.headers as Record<string, string>)["authorization"]);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await postSiteReport(s, "2026-11-11T09:00:00Z", { WORKFORCE_SCHEDULER_SECRET: "s3cret-value" }, (l) => logs.push(l), f);
    expect(auth).toBe("Bearer s3cret-value");
    expect(logs.join(" ")).not.toContain("s3cret-value");
    expect(logs[0]).toContain("http 200");
    await postSiteReport(s, "x", {}, (l) => logs.push(l), f);
    expect(logs[1]).toContain("no scheduler variable");
  });
});
