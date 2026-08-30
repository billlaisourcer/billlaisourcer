import { z } from "zod";
import { BANDS, DIMENSIONS, PIN_STATUSES } from "./rubric.js";

/**
 * The contract the model must produce. Mirrors schema/intake.schema.json so a
 * generated slate drops straight into scripts/score_candidates.py unchanged.
 */

const ScoreEntry = z.object({
  /** 0-5, or null when the profile carries no evidence either way. */
  rating: z.number().min(0).max(5).nullable(),
  /** The specific profile fact behind the rating. Required even when null. */
  evidence: z.string().min(1),
});

const Scores = z.object(
  Object.fromEntries(DIMENSIONS.map((d) => [d, ScoreEntry])) as Record<
    (typeof DIMENSIONS)[number],
    typeof ScoreEntry
  >,
);

export const CandidateSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  company: z.string().optional(),
  location: z.string().optional(),
  linkedin: z.string().optional(),
  sources: z.object({
    seekout: z.boolean().optional(),
    pin: z.boolean().optional(),
    supercarl: z.boolean().optional(),
  }),
  pin_status: z.enum(PIN_STATUSES).optional(),
  band: z.enum(BANDS),
  calibration_question: z.string().min(1),
  /** Warm-path signal — Super Carl's differentiator over a plain index. */
  intro_path: z.string().optional(),
  scores: Scores,
});

export const IntakeSchema = z.object({
  req: z.object({
    title: z.string().min(1),
    company: z.string().min(1),
    location: z.string().optional(),
    seniority_band: z.string().optional(),
    must_haves: z.array(z.string()).min(1).max(6),
    nice_to_haves: z.array(z.string()).optional(),
    target_companies: z.array(z.string()).optional(),
    open_questions: z.array(z.string()).max(2).optional(),
  }),
  weights: z
    .object(
      Object.fromEntries(DIMENSIONS.map((d) => [d, z.number().int()])) as Record<
        (typeof DIMENSIONS)[number],
        z.ZodNumber
      >,
    )
    .partial()
    .optional(),
  weights_rationale: z.string().optional(),
  candidates: z.array(CandidateSchema).min(1),
});

export type Intake = z.infer<typeof IntakeSchema>;

/**
 * Pull the JSON object out of a model response.
 *
 * We ask for JSON in the text rather than using output_config.format because
 * the response also carries mcp_tool_use / mcp_tool_result blocks from the
 * connector, and constraining the whole response shape alongside a live tool
 * loop is an interaction we cannot verify here. Tolerant extraction plus strict
 * Zod validation gives the same guarantee with no untested coupling.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = fenced?.[1] ?? text;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in the model response.");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}
