/**
 * Jev screening — a second, cheap opinion on whether a person meets a list of
 * requirements, judged from their Super Carl profile.
 *
 * Jev (TypeSafe AI) is a "System One" model: it returns typed answers with
 * probabilities, never prose. That suits this job, which is a closed question
 * asked many times — does this profile support, contradict, or say nothing
 * about this requirement — and suits it at volume, because Jev is priced per
 * billion input tokens rather than per call.
 *
 * The decomposition follows TypeSafe's own citation-check cookbook: one Choice
 * per claim over the evidence, with `says_nothing` kept distinct from
 * `contradicts`. That is the same distinction the rubric draws between a null
 * rating (no evidence) and a 0 (evidence of failure).
 *
 * HTTP contract, from https://docs.typesafe.ai/api.md:
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <key>
 *   { state, model: "jev-latest", questions: { <id>: { type, instructions, criteria } } }
 *   -> { answers: { <id>: { type, choice?, probabilities?, noul?, confidence? } } }
 *
 * Limits worth knowing: what Jev sees is only what is in `state`. A Super Carl
 * row carries a headline, a skills list and a title/company/dates history with
 * no descriptions, so requirements that turn on WHAT someone did in a role
 * (rather than what the role was) will mostly come back `says_nothing`. That is
 * the correct answer, not a failure.
 */

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

/**
 * Below this a Choice is treated as unsettled. TypeSafe's cookbook starts at 0.8
 * and advises lowering it only once the model's behaviour on your data is
 * known — this has not been tuned on real recruiting data yet.
 */
export const CONFIDENCE_FLOOR = 0.8;

/**
 * The docs do not state a per-request question cap. Rather than find out with a
 * 422 in production, questions are sent in groups of this size.
 */
export const MAX_QUESTIONS_PER_REQUEST = 8;

const MAX_EXPERIENCES = 8;
const MAX_SKILLS = 40;

/** Model rating on a 0-5 scale vs Jev's 0-1 coverage. Starting values, untuned. */
export const DISAGREE_DELTA = 0.35;

export type SuperCarlRow = {
  name?: string;
  linkedin_url?: string;
  headline?: string;
  current_title?: string;
  current_company?: string;
  location?: string;
  skills?: string[];
  experiences?: {
    title?: string;
    company?: string;
    is_current?: boolean;
    started_at?: string;
    ended_at?: string;
  }[];
};

export type Verdict = "supports" | "contradicts" | "says_nothing" | "unknown";

export type ReqResult = {
  verdict: Verdict;
  p_supports: number;
  p_contradicts: number;
  confidence: number | null;
  /** Confidence at or above the floor. Unsettled answers should be read, not trusted. */
  settled: boolean;
};

export type Screened = {
  key: string;
  name?: string;
  linkedin?: string;
  title?: string;
  company?: string;
  must: ReqResult[];
  /** P(yes) per nice-to-have, null where the call failed. */
  nice: (number | null)[];
  /** Mean P(supports) across the must-haves, 0-1. Null if none could be judged. */
  coverage: number | null;
  supports: number;
  contradicts: number;
  unknown: number;
  unsettled: number;
  error?: string;
};

/* ---------- identity ---------- */

/** linkedin.com/in/x — protocol, www, query string and trailing slash removed. */
export function normLinkedin(url: string | undefined | null): string {
  if (!url) return "";
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

export function rowKey(row: { linkedin_url?: string; name?: string }): string {
  return normLinkedin(row.linkedin_url) || (row.name ?? "").trim().toLowerCase();
}

/* ---------- pulling rows out of tool results ---------- */

/**
 * Super Carl people rows from mcp_tool_result blocks, de-duplicated. Tolerant by
 * design: the blocks are whatever the connector handed back, and one that does
 * not parse must not cost the caller the ones that do.
 */
export function rowsFromToolResults(blocks: unknown[]): SuperCarlRow[] {
  const seen = new Map<string, SuperCarlRow>();

  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const block = b as { type?: string; content?: unknown };
    if (block.type !== "mcp_tool_result") continue;

    let text = "";
    if (typeof block.content === "string") text = block.content;
    else if (Array.isArray(block.content)) {
      text = block.content
        .map((c) =>
          c && typeof c === "object" && (c as { type?: string }).type === "text"
            ? String((c as { text?: unknown }).text ?? "")
            : "",
        )
        .join("");
    }
    if (!text) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const people = (parsed as { people?: unknown })?.people;
    if (!Array.isArray(people)) continue;

    for (const p of people) {
      if (!p || typeof p !== "object") continue;
      const row = p as SuperCarlRow;
      const key = rowKey(row);
      if (!key) continue;
      // A later search may return the same person with more fields; keep the richer.
      const prev = seen.get(key);
      if (!prev || richness(row) > richness(prev)) seen.set(key, row);
    }
  }
  return [...seen.values()];
}

function richness(r: SuperCarlRow): number {
  return (r.experiences?.length ?? 0) * 2 + (r.skills?.length ?? 0) + (r.headline ? 1 : 0);
}

/* ---------- request building ---------- */

/**
 * What Jev is shown. Name and LinkedIn URL are deliberately left out: they carry
 * no evidence about fit and are exactly the fields a model could be swayed by.
 */
export function profileState(row: SuperCarlRow): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  if (row.headline) state.headline = row.headline;
  if (row.current_title) state.current_title = row.current_title;
  if (row.current_company) state.current_company = row.current_company;
  if (row.location) state.location = row.location;

  const exps = (row.experiences ?? []).slice(0, MAX_EXPERIENCES).map((e) => {
    const out: Record<string, unknown> = {};
    if (e.title) out.title = e.title;
    if (e.company) out.company = e.company;
    if (e.is_current) out.current = true;
    if (e.started_at) out.started = e.started_at;
    if (e.ended_at) out.ended = e.ended_at;
    return out;
  });
  if (exps.length) state.experience = exps;

  const skills = (row.skills ?? []).slice(0, MAX_SKILLS);
  if (skills.length) state.skills = skills;
  return state;
}

export function buildQuestions(
  requirements: string[],
  niceToHaves: string[] = [],
): Record<string, unknown> {
  const q: Record<string, unknown> = {};

  requirements.forEach((req, i) => {
    q[`must_${i}`] = {
      type: "choice",
      // Ids are not sent to the model, so the requirement travels in the text.
      instructions:
        `Requirement: ${req}\n\n` +
        `Does this person's profile show they meet the requirement?`,
      criteria: {
        supports: "The profile states or directly shows that they meet the requirement.",
        contradicts:
          "The profile shows they do not meet it, for example a different function, " +
          "a different level, or a location that rules them out.",
        says_nothing:
          "The profile does not address the requirement either way. Absence of " +
          "information, which is not evidence that they fail it.",
      },
    };
  });

  niceToHaves.forEach((nice, i) => {
    q[`nice_${i}`] = {
      type: "noul",
      instructions: `Does this person's profile show the following? ${nice}`,
      criteria: {
        true: "The profile states or directly shows it.",
        false: "The profile does not show it.",
      },
    };
  });

  return q;
}

/** Split a question map into request-sized groups, preserving order. */
export function chunkQuestions(
  questions: Record<string, unknown>,
  size = MAX_QUESTIONS_PER_REQUEST,
): Record<string, unknown>[] {
  const entries = Object.entries(questions);
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < entries.length; i += size) {
    out.push(Object.fromEntries(entries.slice(i, i + size)));
  }
  return out;
}

/* ---------- reading answers ---------- */

type Answer = {
  type?: string;
  choice?: string;
  noul?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
};

export function readMust(answer: Answer | undefined): ReqResult {
  if (!answer || answer.type !== "choice" || !answer.probabilities) {
    return { verdict: "unknown", p_supports: 0, p_contradicts: 0, confidence: null, settled: false };
  }
  const probs = answer.probabilities;
  const choice = answer.choice;
  const verdict: Verdict =
    choice === "supports" || choice === "contradicts" || choice === "says_nothing"
      ? choice
      : "unknown";
  const confidence = typeof answer.confidence === "number" ? answer.confidence : null;
  return {
    verdict,
    p_supports: clamp01(probs.supports ?? (verdict === "supports" ? 1 : 0)),
    p_contradicts: clamp01(probs.contradicts ?? (verdict === "contradicts" ? 1 : 0)),
    confidence,
    settled: confidence !== null && confidence >= CONFIDENCE_FLOOR,
  };
}

export function readNice(answer: Answer | undefined): number | null {
  if (!answer || answer.type !== "noul" || typeof answer.noul !== "number") return null;
  return clamp01(answer.noul);
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Fold per-requirement results into one candidate's summary. */
export function summarise(
  row: SuperCarlRow,
  must: ReqResult[],
  nice: (number | null)[],
  error?: string,
): Screened {
  const judged = must.filter((m) => m.verdict !== "unknown");
  const coverage = judged.length
    ? judged.reduce((sum, m) => sum + m.p_supports, 0) / must.length
    : null;
  return {
    key: rowKey(row),
    name: row.name,
    linkedin: row.linkedin_url,
    title: row.current_title,
    company: row.current_company,
    must,
    nice,
    coverage,
    supports: must.filter((m) => m.verdict === "supports").length,
    contradicts: must.filter((m) => m.verdict === "contradicts").length,
    unknown: must.filter((m) => m.verdict === "says_nothing" || m.verdict === "unknown").length,
    unsettled: must.filter((m) => m.verdict !== "unknown" && !m.settled).length,
    error,
  };
}

/**
 * How Jev's reading sits against the model's must_have_coverage rating.
 *
 * Two different disagreements look alike and are not, so they get different
 * names:
 *
 *   conflict    — the model credited the person (>= 4) but Jev found a must-have
 *                 the profile CONTRADICTS. Evidence against, not lack of it.
 *   unverified  — the model rated far above what Jev could confirm, with nothing
 *                 contradicted. A Super Carl row has no role descriptions, so Jev
 *                 will often find nothing to confirm; the model may have inferred
 *                 it reasonably. That is a reason to check, not to doubt.
 *
 * Only `conflict` (and its mirror, `model_harsh`) deserve to interrupt a reader.
 * Firing on every gap would flag nearly everyone and teach people to ignore it.
 *
 * The model rates 0-5 and Jev's coverage is a 0-1 mean probability, so the
 * scales are not equal and the thresholds are starting points, not findings.
 */
export type Flag = "conflict" | "unverified" | "model_harsh" | "agree";

/** P(contradicts) at or above this counts as the profile contradicting a requirement. */
export const CONTRADICTION_P = 0.6;

export function compareToModel(
  s: Pick<Screened, "coverage" | "must">,
  modelRating: number | null | undefined,
): Flag | null {
  if (s.coverage === null || modelRating === null || modelRating === undefined) return null;

  const contradicted = s.must.some(
    (m) => m.verdict === "contradicts" && m.p_contradicts >= CONTRADICTION_P,
  );
  if (modelRating >= 4 && contradicted) return "conflict";

  const delta = modelRating / 5 - s.coverage;
  if (delta >= DISAGREE_DELTA) return "unverified";
  if (delta <= -DISAGREE_DELTA) return "model_harsh";
  return "agree";
}

/** Highest coverage first; fewer contradictions break ties; name keeps it stable. */
export function rank(items: Screened[]): Screened[] {
  return [...items].sort((a, b) => {
    const ac = a.coverage ?? -1;
    const bc = b.coverage ?? -1;
    if (bc !== ac) return bc - ac;
    if (a.contradicts !== b.contradicts) return a.contradicts - b.contradicts;
    return (a.name ?? a.key).localeCompare(b.name ?? b.key);
  });
}

/* ---------- calling Jev ---------- */

export class JevAuthError extends Error {}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function callJev(
  fetchImpl: FetchLike,
  apiKey: string,
  state: unknown,
  questions: Record<string, unknown>,
): Promise<Record<string, Answer>> {
  let lastStatus = 0;
  // 429 and 529 are the documented retryable statuses, and the docs ask for
  // exponential backoff rather than an immediate retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchImpl(JEV_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ state, model: JEV_MODEL, questions }),
    });
    lastStatus = res.status;

    if (res.ok) {
      const body = (await res.json()) as { answers?: Record<string, Answer> };
      return body.answers ?? {};
    }
    if (res.status === 401) throw new JevAuthError("Jev rejected the API key.");
    if (res.status !== 429 && res.status !== 529) break;
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  throw new Error(`Jev returned ${lastStatus}.`);
}

export type ScreenOptions = {
  apiKey: string;
  requirements: string[];
  niceToHaves?: string[];
  rows: SuperCarlRow[];
  /** Absolute epoch ms after which no new work starts. */
  deadline?: number;
  concurrency?: number;
  fetchImpl?: FetchLike;
};

export type ScreenOutcome = {
  results: Screened[];
  /** Rows never sent because the deadline passed first. */
  skipped: number;
};

export async function screen(opts: ScreenOptions): Promise<ScreenOutcome> {
  const {
    apiKey,
    requirements,
    niceToHaves = [],
    rows,
    deadline = Infinity,
    concurrency = 8,
    fetchImpl = fetch as FetchLike,
  } = opts;

  const groups = chunkQuestions(buildQuestions(requirements, niceToHaves));
  const results: Screened[] = [];
  let skipped = 0;

  async function one(row: SuperCarlRow): Promise<Screened> {
    const state = profileState(row);
    const answers: Record<string, Answer> = {};
    try {
      for (const group of groups) {
        Object.assign(answers, await callJev(fetchImpl, apiKey, state, group));
      }
      return summarise(
        row,
        requirements.map((_, i) => readMust(answers[`must_${i}`])),
        niceToHaves.map((_, i) => readNice(answers[`nice_${i}`])),
      );
    } catch (err) {
      if (err instanceof JevAuthError) throw err;
      return summarise(
        row,
        requirements.map(() => readMust(undefined)),
        niceToHaves.map(() => null),
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  for (let i = 0; i < rows.length; i += concurrency) {
    if (Date.now() >= deadline) {
      skipped = rows.length - i;
      break;
    }
    const batch = rows.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map(one))));
  }
  return { results, skipped };
}

/* ---------- placing a slate inside a pool ---------- */

export type SlateMember = {
  name: string;
  linkedin?: string;
  modelRating?: number | null;
};

export type JevReport = {
  requirements: string[];
  niceToHaves: string[];
  /** The slate, in slate order, each with Jev's reading and how it compares. */
  slate: (Screened & {
    flag: Flag | null;
    /**
     * True when no search result could be matched to this person. Matching is by
     * LinkedIn URL and then by exact name, so this means "could not be matched",
     * which is weaker than "was not in the results": a name written differently
     * in the slate misses.
     */
    unmatched: boolean;
  })[];
  /** Best-covered people the searches returned who are NOT in the slate. */
  pool: Screened[];
  screened: number;
  skipped: number;
  errors: number;
};

export function report(
  requirements: string[],
  niceToHaves: string[],
  slate: SlateMember[],
  outcome: ScreenOutcome,
  poolLimit = 8,
): JevReport {
  const byKey = new Map(outcome.results.map((r) => [r.key, r]));
  const slateKeys = new Set<string>();

  const placed = slate.map((m) => {
    const key = rowKey({ linkedin_url: m.linkedin, name: m.name });
    const hit = byKey.get(key) ?? byKey.get(m.name.trim().toLowerCase());
    if (hit) slateKeys.add(hit.key);
    slateKeys.add(key);

    const base: Screened = hit ?? {
      key,
      name: m.name,
      linkedin: m.linkedin,
      must: requirements.map(() => readMust(undefined)),
      nice: niceToHaves.map(() => null),
      coverage: null,
      supports: 0,
      contradicts: 0,
      unknown: requirements.length,
      unsettled: 0,
    };
    return {
      ...base,
      flag: compareToModel(base, m.modelRating),
      unmatched: !hit,
    };
  });

  const pool = rank(
    outcome.results.filter((r) => !slateKeys.has(r.key) && r.coverage !== null && !r.error),
  ).slice(0, poolLimit);

  return {
    requirements,
    niceToHaves,
    slate: placed,
    pool,
    screened: outcome.results.length,
    skipped: outcome.skipped,
    errors: outcome.results.filter((r) => r.error).length,
  };
}
