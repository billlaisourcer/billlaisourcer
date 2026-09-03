import { z } from "zod";

/**
 * The contract for a recruiter submission — one candidate, written up for a
 * client from a screening call plus a resume.
 *
 * The governing rule is provenance. A submission that quietly invents a
 * compensation number or a reason for leaving does not merely contain an
 * error; it burns the recruiter's credibility with the client the moment it is
 * checked. So every extracted field carries where it came from, and a field
 * nobody established is null — never a plausible guess. The page turns those
 * nulls into a checklist of what still needs asking, which makes the honest
 * answer the useful one too.
 */

export const SOURCES = ["call", "resume", "both", "inferred"] as const;

/**
 * One extracted fact.
 *
 * `value: null` means no one established it. `source: "inferred"` means it was
 * read between the lines rather than stated, which a recruiter must be able to
 * see before repeating it to a client as fact.
 */
const Field = z.object({
  value: z.string().min(1).nullable(),
  source: z.enum(SOURCES).nullable(),
  /** The words behind it, from the notes or the resume. */
  quote: z.string().nullable().optional(),
});

export type Field = z.infer<typeof Field>;

/** Whether the person sells to businesses or consumers. */
export const MOTIONS = ["b2b", "b2c", "both", "unclear"] as const;

export const MUST_HAVE_VERDICTS = ["met", "partial", "not_met", "unknown"] as const;

export const SubmissionSchema = z.object({
  candidate: z.object({
    name: z.string().min(1),
    current_title: z.string().nullable(),
    current_company: z.string().nullable(),
    linkedin: z.string().nullable().optional(),
  }),

  /** Where they are, and what they will actually accept. */
  location: Field,
  work_preference: Field,
  work_authorization: Field,

  background: z.object({
    years_experience: Field,
    /** The markets they have actually worked in, e.g. ["fintech", "devtools"]. */
    domains: z.array(z.string()).max(8),
    motion: z.enum(MOTIONS),
    motion_evidence: z.string().min(1),
    company_stages: Field,
    /** Concrete, checkable accomplishments — not adjectives. */
    highlights: z.array(z.string()).max(6),
  }),

  reason_for_leaving: Field,
  looking_for: Field,

  /**
   * How AI-enabled they are. Rated on evidence of doing, not of claiming:
   * shipping an AI feature outranks listing a tool on a resume.
   */
  ai_enablement: z.object({
    rating: z.number().min(0).max(5).nullable(),
    summary: z.string().min(1),
    evidence: z.array(z.string()).max(6),
  }),

  compensation: z.object({
    current: Field,
    expectation: Field,
    /** Equity, bonus, and how firm the number is. */
    notes: Field,
  }),

  availability: z.object({
    notice: Field,
    /** Other processes and offers — what sets the client's clock. */
    other_processes: Field,
  }),

  client_fit: z.object({
    mission_alignment: Field,
    motivation: Field,
    /** Honest risks. A submission with no watch-outs has not been thought about. */
    concerns: z.array(z.string()).max(5),
  }),

  /** Present only when the request carried the role's stated must-haves. */
  must_have_assessment: z
    .array(
      z.object({
        requirement: z.string().min(1),
        verdict: z.enum(MUST_HAVE_VERDICTS),
        evidence: z.string().min(1),
      }),
    )
    .optional(),

  /** The paragraph the client actually reads. Everything else supports it. */
  recruiter_summary: z.string().min(1),
});

export type Submission = z.infer<typeof SubmissionSchema>;

/**
 * The fields a recruiter is expected to come away from a screening call with.
 *
 * Used to derive the coverage checklist deterministically from the record
 * rather than asking the model to self-report what it missed — the same
 * split the scorer uses, where the arithmetic lives in code and the judgement
 * lives in the model.
 */
export const EXPECTED_FIELDS: { path: string; label: string }[] = [
  { path: "reason_for_leaving", label: "Reason for leaving" },
  { path: "looking_for", label: "What they want next" },
  { path: "location", label: "Location" },
  { path: "work_preference", label: "Remote / onsite preference" },
  { path: "work_authorization", label: "Work authorization" },
  { path: "background.years_experience", label: "Years of experience" },
  { path: "background.company_stages", label: "Company stages" },
  { path: "compensation.expectation", label: "Compensation expectation" },
  { path: "compensation.notes", label: "Equity / bonus / flexibility" },
  { path: "availability.notice", label: "Notice period" },
  { path: "availability.other_processes", label: "Other processes in play" },
  { path: "client_fit.mission_alignment", label: "Alignment with the client's mission" },
  { path: "client_fit.motivation", label: "Why this client" },
];
