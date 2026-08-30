/**
 * Single source of truth for the scoring rubric.
 *
 * These constants are mirrored in three places and must agree:
 *   - scripts/score_candidates.py  (the committed CLI scorer)
 *   - public/index.html            (the in-browser scorer)
 *   - this file                    (what the model is told to produce)
 *
 * Change one, change all three, and re-run the parity check in the README.
 */

export const DEFAULT_WEIGHTS = {
  must_have_coverage: 30,
  seniority_scope: 20,
  domain_pedigree: 15,
  skill_depth: 15,
  location_authorization: 10,
  trajectory_stability: 10,
} as const;

export type Dimension = keyof typeof DEFAULT_WEIGHTS;

export const DIMENSIONS = Object.keys(DEFAULT_WEIGHTS) as Dimension[];

export const BANDS = [
  "on_target",
  "stretch_senior",
  "stretch_junior",
  "adjacent",
  "probe",
] as const;

export const PIN_STATUSES = [
  "unreviewed",
  "shortlisted",
  "accepted",
  "rejected",
  "not_found",
] as const;

/** Below this share of evidenced rubric weight, a composite is not comparable. */
export const EVIDENCE_FLOOR = 60;

/** How many profiles a calibration slate should carry. */
export const SLATE_SIZE = 10;

/** Target band mix. A slate that is all on-target cannot calibrate anything. */
export const BAND_TARGETS: Record<(typeof BANDS)[number], string> = {
  on_target: "4-5 — is this the shape the client actually means?",
  stretch_senior: "1-2 — will they stretch on level and comp?",
  stretch_junior: "1-2 — is the years/scope floor real or aspirational?",
  adjacent: "1-2 — how strict are the domain must-haves?",
  probe: "0-1 — a non-obvious read worth a reaction.",
};
