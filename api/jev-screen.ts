import {
  JevAuthError,
  rank,
  screen,
  type SuperCarlRow,
} from "../lib/jev.js";

/**
 * POST /api/jev-screen
 *
 * Body: { requirements: string[], niceToHaves?: string[], rows: SuperCarlRow[] }
 *
 * Screens a list of Super Carl profiles against a list of requirements and
 * returns them ranked. This is the same step the ICP generator runs after a
 * slate, exposed on its own so it can be tried without paying for a sourcing
 * run — a few profiles and a few requirements is a few cents of Jev.
 *
 * Also usable on anything shaped like a Super Carl row, such as a people list
 * pulled from the Talent Mapping page.
 */

export const maxDuration = 60;

const MAX_ROWS = 200;
const MAX_REQUIREMENTS = 6;
const MAX_NICE = 8;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function strings(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, cap);
}

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    return json(
      { error: "TYPESAFE_API_KEY is not set on this deployment. Add it in Vercel and redeploy." },
      503,
    );
  }

  let body: { requirements?: unknown; niceToHaves?: unknown; rows?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const requirements = strings(body.requirements, MAX_REQUIREMENTS);
  const niceToHaves = strings(body.niceToHaves, MAX_NICE);
  if (!requirements.length) return json({ error: "Give at least one requirement." }, 400);

  const rows = Array.isArray(body.rows)
    ? (body.rows.filter((r) => r && typeof r === "object") as SuperCarlRow[]).slice(0, MAX_ROWS)
    : [];
  if (!rows.length) return json({ error: "Give at least one profile in rows." }, 400);

  try {
    const outcome = await screen({
      apiKey,
      requirements,
      niceToHaves,
      rows,
      deadline: startedAt + (maxDuration - 8) * 1000,
    });

    const ranked = rank(outcome.results);
    console.log(
      "jev-screen",
      JSON.stringify({
        rows: rows.length,
        requirements: requirements.length,
        screened: outcome.results.length,
        skipped: outcome.skipped,
        errors: outcome.results.filter((r) => r.error).length,
        ms: Date.now() - startedAt,
      }),
    );

    return json(
      { requirements, niceToHaves, results: ranked, skipped: outcome.skipped, ms: Date.now() - startedAt },
      200,
    );
  } catch (err) {
    if (err instanceof JevAuthError) {
      return json({ error: "Jev rejected the API key." }, 502);
    }
    return json(
      { error: "The screen failed.", detail: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}
