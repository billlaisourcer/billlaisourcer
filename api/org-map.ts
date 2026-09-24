import {
  APOLLO_ORG_SEARCH_URL,
  APOLLO_SEARCH_URL,
  buildOrgSearchParams,
  buildSearchParams,
  type ApolloOrg,
  type ApolloOrgResponse,
} from "../lib/apollo.js";

/**
 * POST /api/org-map
 *
 * Body: { companies: string[], locations: string[], titles: string[],
 *         locationMode?: "person" | "organization", exactTitles?: boolean }
 *
 * Headcount mapping. One row per company/location pair, one column per title,
 * and every cell an exact count — not a sample.
 *
 * The counts come from Apollo People Search's `total_entries`, which is the
 * whole matching population rather than the page returned, so a cell needs
 * per_page=1 and costs 0 credits. Only resolving a company NAME into Apollo
 * ids costs anything (1 credit each); a domain is used directly and costs
 * nothing.
 *
 * Observed against the live API and worth knowing: q_organization_name matches
 * partially, so "Salesforce" resolves to Salesforce Ben, Salesforce Ventures,
 * Trailhead by Salesforce and more, and a count built on it covers all of them.
 * Each row therefore carries the list it was actually built from.
 */

export const maxDuration = 60;

/** companies x locations x titles. 60 cells is ~60 free requests. */
const MAX_CELLS = 60;
const MAX_COMPANIES = 12;
const MAX_LOCATIONS = 6;
const MAX_TITLES = 8;

/** Apollo's free tier allows 600 requests/hour; 8 at a time is polite and quick. */
const CONCURRENCY = 8;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function list(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const s = item.replace(/\s+/g, " ").trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

function looksLikeDomain(s: string): boolean {
  return /^[^\s@]+\.[a-z]{2,}$/i.test(s);
}

async function inBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

type Target = {
  input: string;
  organizationIds: string[];
  domains: string[];
  /** Every company Apollo folded into this row, so a widened match is visible. */
  resolvedNames: string[];
};

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    return json({ error: "APOLLO_API_KEY is not set on this deployment." }, 503);
  }

  let body: {
    companies?: unknown;
    locations?: unknown;
    titles?: unknown;
    locationMode?: unknown;
    exactTitles?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const companies = list(body.companies, MAX_COMPANIES);
  const titles = list(body.titles, MAX_TITLES);
  // No location is a legitimate map: it means "everywhere".
  const locations = list(body.locations, MAX_LOCATIONS);
  const locationMode = body.locationMode === "organization" ? "organization" : "person";
  const exactTitles = body.exactTitles === true;

  if (!companies.length) return json({ error: "Add at least one company." }, 400);
  if (!titles.length) return json({ error: "Add at least one job title." }, 400);

  const rowLocations = locations.length ? locations : [""];
  const cells = companies.length * rowLocations.length * titles.length;
  if (cells > MAX_CELLS) {
    return json(
      {
        error:
          `That grid is ${cells} cells (${companies.length} companies x ` +
          `${rowLocations.length} locations x ${titles.length} titles). The cap is ` +
          `${MAX_CELLS} — drop a title or a location and run it again.`,
      },
      400,
    );
  }

  // ---- resolve each company to the ids or domain its counts will use ----
  const targets: Target[] = [];
  let orgCreditsSpent = 0;

  try {
    for (const input of companies) {
      if (looksLikeDomain(input)) {
        targets.push({ input, organizationIds: [], domains: [input], resolvedNames: [] });
        continue;
      }
      const params = buildOrgSearchParams({
        name: input,
        keywords: [],
        locations: locationMode === "organization" ? locations : [],
        perPage: 25,
      });
      const res = await fetch(`${APOLLO_ORG_SEARCH_URL}?${params.toString()}`, {
        method: "POST",
        headers: { "x-api-key": apiKey, accept: "application/json", "content-type": "application/json" },
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        return json(
          {
            error:
              res.status === 403
                ? "That Apollo key cannot search companies, which is how a company name becomes a filter."
                : `Apollo company search returned ${res.status}.`,
            detail,
          },
          res.status === 429 ? 429 : 502,
        );
      }
      orgCreditsSpent += 1;
      const payload = (await res.json()) as ApolloOrgResponse;
      const orgs: ApolloOrg[] = [...(payload.organizations ?? []), ...(payload.accounts ?? [])];
      targets.push({
        input,
        organizationIds: orgs.map((o) => o.id).filter((id): id is string => !!id),
        domains: [],
        resolvedNames: orgs.map((o) => o.name ?? "").filter(Boolean),
      });
    }
  } catch (err) {
    return json(
      { error: "Could not reach Apollo to resolve companies.", detail: err instanceof Error ? err.message : String(err) },
      504,
    );
  }

  // ---- one count per cell ----
  type Job = { ci: number; li: number; ti: number };
  const jobs: Job[] = [];
  targets.forEach((_, ci) =>
    rowLocations.forEach((_l, li) => titles.forEach((_t, ti) => jobs.push({ ci, li, ti }))),
  );

  const counts = new Map<string, number | null>();
  let failed = 0;

  await inBatches(jobs, CONCURRENCY, async (job) => {
    const target = targets[job.ci]!;
    const location = rowLocations[job.li]!;
    const title = titles[job.ti]!;
    const key = `${job.ci}:${job.li}:${job.ti}`;

    // A company that resolved to nothing can only produce a meaningless
    // whole-market count, so it is left unknown rather than filled with one.
    if (!target.organizationIds.length && !target.domains.length) {
      counts.set(key, null);
      return;
    }

    const params = buildSearchParams({
      titles: [title],
      locations: location ? [location] : [],
      locationMode,
      seniorities: [],
      employeeRanges: [],
      exactTitles,
      organizationIds: target.organizationIds,
      domains: target.domains,
      page: 1,
      // The count lives in total_entries, so a cell never needs the people.
      perPage: 1,
    });

    try {
      const res = await fetch(`${APOLLO_SEARCH_URL}?${params.toString()}`, {
        method: "POST",
        headers: { "x-api-key": apiKey, accept: "application/json", "content-type": "application/json" },
      });
      if (!res.ok) {
        failed += 1;
        counts.set(key, null);
        return;
      }
      const payload = (await res.json()) as { total_entries?: number };
      counts.set(key, typeof payload.total_entries === "number" ? payload.total_entries : null);
    } catch {
      failed += 1;
      counts.set(key, null);
    }
  });

  const rows = targets.flatMap((target, ci) =>
    rowLocations.map((location, li) => ({
      company: target.input,
      location,
      resolvedNames: target.resolvedNames,
      unresolved: !target.organizationIds.length && !target.domains.length,
      cells: titles.map((title, ti) => ({
        title,
        apollo: counts.get(`${ci}:${li}:${ti}`) ?? null,
      })),
    })),
  );

  console.log(
    "org-map",
    JSON.stringify({ companies: companies.length, locations: rowLocations.length, titles: titles.length, cells, failed, orgCreditsSpent }),
  );

  return json(
    {
      titles,
      rows,
      cells,
      failed,
      orgCreditsSpent,
      query: { companies, locations, titles, locationMode, exactTitles },
    },
    200,
  );
}
