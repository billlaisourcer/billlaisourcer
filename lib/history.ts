import { createHash, timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { Intake } from "./intake-schema.js";
import type { Submission } from "./submission-schema.js";

/**
 * Server-side history for sourcing runs and recruiter submissions.
 *
 * Every run is written twice: the full record under its own key, and a compact
 * summary as a member of one sorted set. The list view is then a single read —
 * no fan-out over N keys just to render N rows — and opening an entry is one
 * more.
 *
 * Retention is a TTL on the record rather than a cleanup job. The 30-day window
 * the UI promises therefore enforces itself, and candidate PII ages out of the
 * store on its own instead of accumulating until someone remembers to prune it.
 */

/** The retention window. The UI states this number, so it lives in one place. */
export const WINDOW_DAYS = 30;
const WINDOW_SECONDS = WINDOW_DAYS * 24 * 60 * 60;
const WINDOW_MS = WINDOW_SECONDS * 1000;

/**
 * One shared bucket. The access gate is a single shared password held in the
 * page source, so there is no user identity to scope history to — every visitor
 * is literally the same principal, and a per-user key would be a label rather
 * than an isolation boundary. Keeping the scope in the key means switching to
 * real per-user buckets later is a change here, not a migration.
 */
const SCOPE = "shared";

/**
 * The two things worth keeping: a sourcing run, and a candidate submission.
 * They differ only in what their summary carries, so they share one store and
 * one set of primitives, separated by key prefix.
 */
export const KINDS = ["run", "sub"] as const;
export type Kind = (typeof KINDS)[number];

const indexKey = (kind: Kind) => `sdtalent:${kind}s:${SCOPE}`;
const itemKey = (kind: Kind, id: string) => `sdtalent:${kind}:${id}`;

/**
 * Hard ceiling on index members. The TTL sweep below already bounds this in
 * normal use; the cap is what stops a runaway from growing the single read that
 * backs the list view without limit.
 */
const MAX_INDEX = 500;

/** Ids are interpolated into a key, so only ever accept ones we minted. */
const ID_RE = /^[0-9a-f-]{8,64}$/;

/** JDs are pasted, so they can be arbitrarily long. Store a sane prefix. */
const MAX_JD_CHARS = 20000;

export interface RunCriteria {
  jd: string;
  location: string;
  notes: string;
  must_haves: string[];
  nice_to_haves: string[];
  count: number;
  /** Empty on a first pass; the recruiter's words on a recalibration. */
  feedback: string;
  /** The slate the feedback was reacting to, as "name — title @ company". */
  previous: string[];
}

export interface RunMeta {
  /** Which model produced the slate. Recorded so an old run explains itself. */
  model?: string;
  searches: number;
  candidates: number;
  stop_reason: string | null;
  usage: Record<string, number>;
  cost_usd: number;
  elapsed_ms: number;
}

export interface StoredRun {
  id: string;
  created_at: string;
  /**
   * Who ran it. Always null today — the gate has no name field, so there is
   * nothing truthful to put here. Recorded now so entries can be attributed
   * later without rewriting records already in the store.
   */
  operator: string | null;
  criteria: RunCriteria;
  intake: Intake;
  meta: RunMeta;
}

/** What the submission page sends in, echoed back so a record explains itself. */
export interface SubmissionContext {
  /** Who the submission is going to, and for what. Both may be blank. */
  client: string;
  role: string;
  /** The raw screening-call notes. */
  notes: string;
  /** Resume text, when pasted; a filename when a PDF was uploaded instead. */
  resume_text: string;
  resume_filename: string;
  /** Role context, either pasted or pulled from a stored search. */
  jd: string;
  must_haves: string[];
  /** The search this was calibrated against, when one was picked. */
  run_id: string | null;
}

export interface SubmissionMeta {
  /** Which model wrote the submission. */
  model?: string;
  stop_reason: string | null;
  usage: Record<string, number>;
  cost_usd: number;
  elapsed_ms: number;
  /** How many expected fields the call did not establish. */
  gaps: number;
  /** Whether a resume reached the model, and in what form. */
  resume: "pdf" | "text" | "none";
}

export interface StoredSubmission {
  id: string;
  created_at: string;
  operator: string | null;
  context: SubmissionContext;
  submission: Submission;
  meta: SubmissionMeta;
}

/** Every summary carries at least these; the rest is per-kind. */
export interface Summary {
  id: string;
  at: string;
}

export interface SubmissionSummary extends Summary {
  name: string;
  title: string;
  company: string;
  client: string;
  role: string;
  cost_usd: number;
  gaps: number;
}

/** What the list view needs. Kept small — every row of it is read at once. */
export interface RunSummary {
  id: string;
  at: string;
  title: string;
  company: string;
  location: string;
  /** Profiles in the slate. */
  n: number;
  cost_usd: number;
  /** True when this run was a recalibration of an earlier slate. */
  recal: boolean;
}

/**
 * The Vercel Upstash integration injects its credentials under one of two
 * names depending on how the store was provisioned — the current
 * `UPSTASH_REDIS_REST_*` pair, or the `KV_REST_API_*` pair inherited from the
 * product's Vercel KV days. Accept both so provisioning cannot pick the wrong
 * one.
 */
let client: Redis | null | undefined;

export function storage(): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  client = url && token ? new Redis({ url, token }) : null;
  return client;
}

/** True when a history store is connected. False means degrade, not fail. */
export function storageConfigured(): boolean {
  return storage() !== null;
}

export function newRunId(): string {
  return crypto.randomUUID();
}

/** Trim a pasted JD to something a record can reasonably carry. */
export function clampJd(jd: string): string {
  return jd.length > MAX_JD_CHARS ? `${jd.slice(0, MAX_JD_CHARS)}\n…[truncated]` : jd;
}

function summarizeRun(run: StoredRun): RunSummary {
  return {
    id: run.id,
    at: run.created_at,
    title: run.intake.req.title,
    company: run.intake.req.company,
    location: run.criteria.location || run.intake.req.location || "",
    n: run.intake.candidates.length,
    cost_usd: run.meta.cost_usd,
    recal: run.criteria.feedback.length > 0,
  };
}

function summarizeSubmission(sub: StoredSubmission): SubmissionSummary {
  return {
    id: sub.id,
    at: sub.created_at,
    name: sub.submission.candidate.name,
    title: sub.submission.candidate.current_title ?? "",
    company: sub.submission.candidate.current_company ?? "",
    client: sub.context.client,
    role: sub.context.role,
    cost_usd: sub.meta.cost_usd,
    gaps: sub.meta.gaps,
  };
}

/**
 * Persist a record. Never throws.
 *
 * These runs cost real money and minutes of wall clock; losing one because the
 * store hiccupped would be a far worse failure than not recording it. Callers
 * get a boolean and report it, and the work still returns its result either
 * way.
 */
async function save(
  kind: Kind,
  id: string,
  createdAt: string,
  record: unknown,
  summary: unknown,
): Promise<boolean> {
  const redis = storage();
  if (!redis) return false;

  const index = indexKey(kind);
  const at = Date.parse(createdAt) || Date.now();
  try {
    await redis.set(itemKey(kind, id), record, { ex: WINDOW_SECONDS });
    await redis.zadd(index, { score: at, member: summary });
    // Drop index members whose records have expired, so the list never offers
    // an entry that opens onto nothing.
    await redis.zremrangebyscore(index, 0, at - WINDOW_MS);
    await redis.zremrangebyrank(index, 0, -(MAX_INDEX + 1));
    return true;
  } catch (err) {
    console.error("history: save failed", err instanceof Error ? err.message : err);
    return false;
  }
}

export function saveRun(run: StoredRun): Promise<boolean> {
  return save("run", run.id, run.created_at, run, summarizeRun(run));
}

export function saveSubmission(sub: StoredSubmission): Promise<boolean> {
  return save("sub", sub.id, sub.created_at, sub, summarizeSubmission(sub));
}

/**
 * The client deserializes JSON values on the way out, so a member comes back
 * as an object — but it round-trips as a string on some paths. Normalize
 * rather than depending on which.
 */
function asSummary(raw: unknown): (Record<string, unknown> & Summary) | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  return typeof s.id === "string" && typeof s.at === "string"
    ? (s as Record<string, unknown> & Summary)
    : null;
}

/** Newest first. Returns null only when no store is connected. */
async function list<T extends Summary>(kind: Kind): Promise<T[] | null> {
  const redis = storage();
  if (!redis) return null;

  // Read the whole index by rank and order in JS. Ranged-by-score reads have a
  // reversed argument order under REV that is easy to get subtly wrong, and the
  // index is capped small enough that this costs nothing.
  const raw = await redis.zrange<unknown[]>(indexKey(kind), 0, -1);
  const cutoff = Date.now() - WINDOW_MS;

  return raw
    .map(asSummary)
    .filter((s): s is Record<string, unknown> & Summary =>
      s !== null && (Date.parse(s.at) || 0) >= cutoff)
    .reverse() as T[];
}

/** Returns null when the record is absent or expired. */
async function get<T>(kind: Kind, id: string): Promise<T | null> {
  const redis = storage();
  if (!redis || !ID_RE.test(id)) return null;
  return (await redis.get<T>(itemKey(kind, id))) ?? null;
}

/**
 * Remove one record and its index entry. Returns false when the store is
 * absent or the id is not one we minted.
 *
 * Both halves are removed, and the index entry is found by reading the index
 * rather than reconstructing the member — the member is the whole summary
 * object, so ZREM needs the exact bytes and rebuilding them risks a mismatch
 * that would leave a row pointing at a deleted record.
 */
async function remove(kind: Kind, id: string): Promise<boolean> {
  const redis = storage();
  if (!redis || !ID_RE.test(id)) return false;
  try {
    await redis.del(itemKey(kind, id));
    const index = indexKey(kind);
    const members = await redis.zrange<unknown[]>(index, 0, -1);
    const doomed = members.filter((m) => asSummary(m)?.id === id);
    if (doomed.length) await redis.zrem(index, ...doomed);
    return true;
  } catch (err) {
    console.error("history: delete failed", err instanceof Error ? err.message : err);
    return false;
  }
}

/** Drop every record of one kind. */
async function clear(kind: Kind): Promise<boolean> {
  const redis = storage();
  if (!redis) return false;
  try {
    const index = indexKey(kind);
    const members = await redis.zrange<unknown[]>(index, 0, -1);
    const ids = members
      .map((m) => asSummary(m)?.id)
      .filter((id): id is string => typeof id === "string" && ID_RE.test(id));
    if (ids.length) await redis.del(...ids.map((id) => itemKey(kind, id)));
    await redis.del(index);
    return true;
  } catch (err) {
    console.error("history: clear failed", err instanceof Error ? err.message : err);
    return false;
  }
}

export const listRuns = () => list<RunSummary>("run");
export const getRun = (id: string) => get<StoredRun>("run", id);

export function deleteByKind(kind: Kind, id: string): Promise<boolean> {
  return remove(kind, id);
}

export function clearByKind(kind: Kind): Promise<boolean> {
  return clear(kind);
}

export const listSubmissions = () => list<SubmissionSummary>("sub");
export const getSubmission = (id: string) => get<StoredSubmission>("sub", id);

/** Dispatch by kind, for the one endpoint that serves both. */
export function listByKind(kind: Kind): Promise<Summary[] | null> {
  return list<Summary>(kind);
}

export function getByKind(kind: Kind, id: string): Promise<unknown | null> {
  return get<unknown>(kind, id);
}

/**
 * Compare a presented token against the configured one without leaking its
 * length or a byte-position match through timing. Hashing first is what lets
 * unequal lengths through timingSafeEqual, which requires equal-sized buffers.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export type AuthResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Gate on APP_ACCESS_TOKEN.
 *
 * Fails closed: with the variable unset there is no correct token, so the
 * endpoint stays shut rather than serving every past search — including
 * candidate names, employers and profile links — to anyone with the URL. The
 * 503 is deliberately distinguishable from the 401 so the UI can say "history
 * is not configured" instead of "wrong password".
 */
export function authorize(request: Request): AuthResult {
  const expected = process.env.APP_ACCESS_TOKEN;
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: "History is not configured: APP_ACCESS_TOKEN is unset on the server.",
    };
  }
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return secretsMatch(presented, expected)
    ? { ok: true }
    : { ok: false, status: 401, error: "Not authorized." };
}
