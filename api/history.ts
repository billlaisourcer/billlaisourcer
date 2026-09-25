import {
  KINDS,
  WINDOW_DAYS,
  authorize,
  clearByKind,
  deleteByKind,
  getByKind,
  listByKind,
  storageConfigured,
  type Kind,
} from "../lib/history.js";

/**
 * GET    /api/history[?kind=run|sub]   → summaries within the retention window
 * GET    /api/history?id=…[&kind=…]    → one full record
 * DELETE /api/history?id=…[&kind=…]    → remove one record
 * DELETE /api/history?all=1[&kind=…]   → remove every record of that kind
 *
 * `kind` selects sourcing runs (the default) or candidate submissions.
 *
 * Auth: Bearer APP_ACCESS_TOKEN. Unlike the generating endpoints — which are
 * deliberately open — this hands back candidate names, employers, profile
 * links and screening-call notes from every past run, so it is gated and fails
 * closed.
 */

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Past searches and submissions are not something an intermediary
      // should hold onto.
      "cache-control": "no-store",
    },
  });
}

/** Shared by both methods: auth, store presence, and the kind parameter. */
function preflight(
  request: Request,
): { ok: false; response: Response } | { ok: true; kind: Kind; params: URLSearchParams } {
  const auth = authorize(request);
  if (!auth.ok) return { ok: false, response: json({ error: auth.error }, auth.status) };

  // Distinguish "no store connected" from "nothing recorded yet". Both look
  // like an empty list to a caller that cannot tell them apart, and only one
  // of them is a problem someone needs to go and fix.
  if (!storageConfigured()) {
    return {
      ok: false,
      response: json(
        {
          error:
            "No history store is connected. Add an Upstash Redis database to the " +
            "project in Vercel → Storage; searches and submissions keep working without it.",
          configured: false,
        },
        503,
      ),
    };
  }

  const params = new URL(request.url).searchParams;
  const requested = params.get("kind") ?? "run";
  if (!(KINDS as readonly string[]).includes(requested)) {
    return { ok: false, response: json({ error: `Unknown kind "${requested}".` }, 400) };
  }
  return { ok: true, kind: requested as Kind, params };
}

export async function DELETE(request: Request): Promise<Response> {
  const pre = preflight(request);
  if (!pre.ok) return pre.response;

  const id = pre.params.get("id");
  const all = pre.params.get("all");

  try {
    if (all === "1") {
      const ok = await clearByKind(pre.kind);
      return json({ cleared: ok }, ok ? 200 : 502);
    }
    if (!id) return json({ error: "Pass id=… or all=1." }, 400);
    const ok = await deleteByKind(pre.kind, id);
    return json({ deleted: ok }, ok ? 200 : 502);
  } catch (err) {
    console.error("history: delete failed", err);
    return json(
      {
        error: "Could not update the history store.",
        detail: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  const auth = authorize(request);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  // Distinguish "no store connected" from "nothing recorded yet". Both look
  // like an empty list to a caller that cannot tell them apart, and only one
  // of them is a problem someone needs to go and fix.
  if (!storageConfigured()) {
    return json(
      {
        error:
          "No history store is connected. Add an Upstash Redis database to the " +
          "project in Vercel → Storage; searches and submissions keep working without it.",
        configured: false,
      },
      503,
    );
  }

  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  const requested = params.get("kind") ?? "run";
  if (!(KINDS as readonly string[]).includes(requested)) {
    return json({ error: `Unknown kind "${requested}".` }, 400);
  }
  const kind = requested as Kind;

  try {
    if (id) {
      const record = await getByKind(kind, id);
      return record
        ? json({ run: record, record, kind }, 200)
        : json({ error: "That record is no longer in the history window." }, 404);
    }
    const rows = (await listByKind(kind)) ?? [];
    // `runs` is the original field name and the first page still reads it;
    // `records` is the kind-neutral one the submission page uses.
    return json(
      { runs: rows, records: rows, kind, window_days: WINDOW_DAYS, configured: true },
      200,
    );
  } catch (err) {
    console.error("history: read failed", err);
    return json(
      {
        error: "Could not read the history store.",
        detail: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
}
