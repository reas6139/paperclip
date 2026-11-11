// Site watcher: the first recurring job built into Paperclip itself (Never dark, 11 Nov 2026).
// Every 10 minutes it asks the public site health page one question and keeps the history of every stall
// (when it began, what kind, how long it lasted). It needs no key, no login and no database: it reads one public URL,
// writes plain log lines, and keeps its history in a small file on the service's own volume.
// A stall episode is any stretch of probes where the site's database does not answer (health says database error or timeout),
// the health page gives no answer in time, or the site returns another error.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const SITE_WATCH_INTERVAL_MS = 10 * 60 * 1000;
export const SITE_WATCH_TIMEOUT_MS = 20_000;
export const SITE_WATCH_DEFAULT_URL = "https://rookshaw.com/api/public/health";
const MAX_EPISODES = 200;

export type SiteState = "ok" | "db_stall" | "no_answer" | "site_error";

export interface SiteProbe {
  at: string;
  state: SiteState;
  http: number;
  ms: number;
  version: string | null;
}

export interface SiteEpisode {
  kind: Exclude<SiteState, "ok">;
  startedAt: string;
  endedAt: string | null;
  probes: number;
}

export interface SiteWatchState {
  current: SiteEpisode | null;
  history: SiteEpisode[];
  lastDailyAt: string | null;
}

export const emptySiteWatchState = (): SiteWatchState => ({ current: null, history: [], lastDailyAt: null });

/** Reads the health answer. Never throws. */
export async function probeSite(
  url: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<SiteProbe> {
  const started = now();
  const at = new Date(started).toISOString();
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(SITE_WATCH_TIMEOUT_MS), redirect: "manual" });
    const body = await res
      .json()
      .then((j) => j as { checks?: { database?: string }; version?: string | null } | null)
      .catch(() => null);
    const db = body?.checks?.database;
    const state: SiteState = res.status === 200 && db === "ok" ? "ok" : db && db !== "ok" ? "db_stall" : "site_error";
    return { at, state, http: res.status, ms: now() - started, version: body?.version ?? null };
  } catch {
    return { at, state: "no_answer", http: 0, ms: now() - started, version: null };
  }
}

const minutesBetween = (a: string, b: string) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));

/** Pure step: folds one probe into the state and returns the log lines it earns. */
export function applyProbe(prev: SiteWatchState, probe: SiteProbe): { state: SiteWatchState; lines: string[] } {
  const lines: string[] = [];
  let { current, history } = prev;
  history = [...history];
  if (probe.state === "ok") {
    if (current) {
      const ended = { ...current, endedAt: probe.at };
      history.push(ended);
      lines.push(
        `[site-watch] stall ended: ${current.kind}, began ${current.startedAt}, lasted about ${minutesBetween(current.startedAt, probe.at)} min (${current.probes} probes)`,
      );
      current = null;
    }
  } else if (!current) {
    current = { kind: probe.state, startedAt: probe.at, endedAt: null, probes: 1 };
    lines.push(`[site-watch] stall started: ${probe.state} at ${probe.at} (http ${probe.http}, ${probe.ms} ms)`);
  } else {
    current = { ...current, probes: current.probes + 1 };
  }
  return { state: { current, history: history.slice(-MAX_EPISODES), lastDailyAt: prev.lastDailyAt }, lines };
}

/** One plain summary line, at most once a day: the line Never dark reads each morning. */
export function dailyLine(state: SiteWatchState, nowIso: string): string | null {
  if (state.lastDailyAt && Date.parse(nowIso) - Date.parse(state.lastDailyAt) < 24 * 3600_000) return null;
  const since = Date.parse(nowIso) - 24 * 3600_000;
  const recent = state.history.filter((e) => e.endedAt && Date.parse(e.endedAt) >= since);
  const minutes = recent.reduce((sum, e) => sum + minutesBetween(e.startedAt, e.endedAt as string), 0);
  const longest = recent.reduce((max, e) => Math.max(max, minutesBetween(e.startedAt, e.endedAt as string)), 0);
  const now = state.current ? `now in a stall since ${state.current.startedAt} (${state.current.kind})` : "now ok";
  return `[site-watch] daily: last 24 h ${recent.length} finished stalls, ${minutes} min total, longest ${longest} min, ${now}`;
}

async function loadState(file: string): Promise<SiteWatchState> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<SiteWatchState>;
    return {
      current: parsed.current ?? null,
      history: Array.isArray(parsed.history) ? parsed.history : [],
      lastDailyAt: parsed.lastDailyAt ?? null,
    };
  } catch {
    return emptySiteWatchState();
  }
}

async function saveState(file: string, state: SiteWatchState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state), "utf8");
  await rename(tmp, file);
}

export const SITE_REPORT_DEFAULT_URL = "https://rookshaw.com/api/public/paperclip-report";

/** The report shape the site's /api/public/paperclip-report route stores (src/lib/paperclip/report.ts on the site). */
export function buildSiteReport(state: SiteWatchState, nowIso: string) {
  const runs = state.history
    .slice(-20)
    .map((e) => ({ agent: "Site watcher", status: `stall ${e.kind}`.slice(0, 40), finished_at: e.endedAt }));
  return {
    version: "site-watcher-1",
    agents: [
      {
        name: "Site watcher",
        role: "devops",
        status: state.current ? `in a stall since ${state.current.startedAt}` : `ok at ${nowIso}`,
        adapter: "built-in",
        budget_monthly_cents: 0,
      },
    ],
    runs,
    issues_open: null,
  };
}

/** Posts the report once a day with the scheduler variable this service already holds (Bearer). The value is never logged. Never throws. */
export async function postSiteReport(
  state: SiteWatchState,
  nowIso: string,
  env: Record<string, string | undefined>,
  log: (line: string) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const secret = env["WORKFORCE_SCHEDULER_SECRET"];
  if (!secret) {
    log("[site-watch] report not sent: no scheduler variable on this service");
    return;
  }
  try {
    const res = await fetchImpl(env["SITE_REPORT_URL"] || SITE_REPORT_DEFAULT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(buildSiteReport(state, nowIso)),
      signal: AbortSignal.timeout(SITE_WATCH_TIMEOUT_MS),
      redirect: "error",
    });
    log(`[site-watch] report to the site: http ${res.status}`);
  } catch {
    log("[site-watch] report to the site: no answer");
  }
}

export interface SiteWatcherDeps {
  homeDir: string;
  log: (line: string) => void;
  url?: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/** One watch tick: probe, fold, log, save. Never throws. */
export async function runSiteWatchTick(deps: SiteWatcherDeps): Promise<void> {
  try {
    const file = path.join(deps.homeDir, "site-watch.json");
    const probe = await probeSite(deps.url ?? SITE_WATCH_DEFAULT_URL, deps.fetchImpl);
    const { state, lines } = applyProbe(await loadState(file), probe);
    const daily = dailyLine(state, probe.at);
    if (daily) {
      lines.push(daily);
      state.lastDailyAt = probe.at;
    }
    for (const line of lines) deps.log(line);
    await saveState(file, state);
    if (daily) await postSiteReport(state, probe.at, deps.env ?? process.env, deps.log);
  } catch {
    // The watcher must never disturb the server it lives in.
  }
}

/** Starts the 10-minute watcher. Switch off with SITE_WATCH_DISABLED=1. Returns the stop function. */
export function startSiteWatcher(deps: SiteWatcherDeps & { env?: Record<string, string | undefined> }): () => void {
  const env = deps.env ?? process.env;
  if (env["SITE_WATCH_DISABLED"] === "1") return () => {};
  const url = env["SITE_WATCH_URL"] || deps.url;
  const tick = () => void runSiteWatchTick({ ...deps, url });
  const first = setTimeout(tick, 30_000);
  const timer = setInterval(tick, SITE_WATCH_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
