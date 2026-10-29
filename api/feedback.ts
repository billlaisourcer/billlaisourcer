/**
 * POST /api/feedback
 *
 * Body: { message: string, name?: string, email?: string, page?: string,
 *         website?: string }
 *
 * Emails the feedback to the sales inbox through Resend's REST API (no SDK, so
 * no new dependency). `website` is a honeypot: the page never shows it, so only
 * a bot fills it in, and those are accepted and dropped without sending.
 *
 * Env:
 *   RESEND_API_KEY   required — without it the endpoint answers 503 and the
 *                    page falls back to a prefilled mailto: link.
 *   FEEDBACK_FROM    sender, e.g. "SD Sourcing Agent <feedback@sourcedirectbi.com>".
 *                    The domain must be verified in Resend. Defaults to Resend's
 *                    test sender, which only delivers to the Resend account owner.
 *   FEEDBACK_TO      recipient; defaults to sales@sourcedirectbi.com.
 *
 * Like the other endpoints this one is open, so the cheap abuse limits live
 * here: a length cap and a best-effort per-IP rate limit.
 */

const DEFAULT_TO = "sales@sourcedirectbi.com";
const DEFAULT_FROM = "SD Sourcing Agent <onboarding@resend.dev>";
const RESEND_URL = "https://api.resend.com/emails";

const MAX_MESSAGE = 4000;
const MIN_MESSAGE = 5;
const MAX_FIELD = 200;

/** Per warm instance, so it blunts a burst rather than guaranteeing a quota. */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function clean(value: unknown, cap: number): string {
  return typeof value === "string" ? value.replace(/\r/g, "").trim().slice(0, cap) : "";
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_PER_WINDOW;
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  if (clean(body.website, 100)) return json({ ok: true }, 200); // honeypot

  const message = clean(body.message, MAX_MESSAGE);
  if (message.length < MIN_MESSAGE) {
    return json({ error: "Please write a little more before sending." }, 400);
  }
  const name = clean(body.name, MAX_FIELD).replace(/\n/g, " ");
  const emailRaw = clean(body.email, MAX_FIELD).replace(/\n/g, " ");
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw : "";
  const page = clean(body.page, MAX_FIELD).replace(/\n/g, " ");

  const ip = (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0]!.trim();
  if (rateLimited(ip)) {
    return json({ error: "Too many messages from this connection. Try again in a few minutes." }, 429);
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return json({ error: "Feedback email is not configured on this deployment.", fallback: true }, 503);
  }

  const text = [
    message,
    "",
    "---",
    `From: ${name || "(no name)"}${email ? ` <${email}>` : " (no email given)"}`,
    page ? `Page: ${page}` : "",
    `Sent: ${new Date().toISOString()}`,
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.FEEDBACK_FROM || DEFAULT_FROM,
        to: [process.env.FEEDBACK_TO || DEFAULT_TO],
        subject: `SD Sourcing Agent feedback${name ? ` from ${name}` : ""}`,
        text,
        ...(email ? { reply_to: email } : {}),
      }),
    });
    if (!res.ok) {
      console.log("feedback send failed", res.status, (await res.text()).slice(0, 300));
      return json({ error: "The message could not be sent.", fallback: true }, 502);
    }
  } catch (err) {
    console.log("feedback send error", err instanceof Error ? err.message : String(err));
    return json({ error: "The message could not be sent.", fallback: true }, 502);
  }

  return json({ ok: true }, 200);
}
