/**
 * Apollo People Search — request shaping and company aggregation.
 *
 * Endpoint: POST https://api.apollo.io/api/v1/mixed_people/api_search
 * Auth:     x-api-key header
 * Cost:     0 credits. Paging is limited by the rate limit, not by spend.
 *
 * The one thing that shapes this whole feature: api_search redacts almost
 * everything about the employer. A person's `organization` carries the company
 * NAME and then only has_* booleans — no domain, no headcount, no industry, no
 * HQ location. So a company map built on this endpoint can rank employers and
 * count people, and cannot report anything about the companies themselves.
 * Enriching that would mean a separate, credit-charging endpoint.
 */

export const APOLLO_SEARCH_URL =
  "https://api.apollo.io/api/v1/mixed_people/api_search";

/** Apollo's own ceiling: 100 per page, 500 pages, 50,000 records displayed. */
export const APOLLO_MAX_PER_PAGE = 100;

/** Seniority values Apollo accepts. Anything else is a 422. */
export const SENIORITIES = [
  "owner",
  "founder",
  "c_suite",
  "partner",
  "vp",
  "head",
  "director",
  "manager",
  "senior",
  "entry",
  "intern",
] as const;

export type Seniority = (typeof SENIORITIES)[number];

export type MapQuery = {
  titles: string[];
  locations: string[];
  /**
   * person — where the person lives. organization — where the employer is
   * headquartered. These answer different questions and Apollo treats them as
   * separate filters, so the caller picks one rather than us guessing.
   */
  locationMode: "person" | "organization";
  seniorities: string[];
  employeeRanges: string[];
  /** Apollo widens to similar titles by default; false pins to exact matches. */
  exactTitles: boolean;
  page: number;
  perPage: number;
};

export type ApolloPerson = {
  id?: string;
  first_name?: string;
  last_name_obfuscated?: string;
  title?: string | null;
  has_email?: boolean;
  organization?: { name?: string | null } | null;
};

export type ApolloSearchResponse = {
  total_entries?: number;
  people?: ApolloPerson[];
};

export type CompanyRow = {
  name: string;
  people: number;
  /** Share of the sample actually counted, not of total_entries. */
  share: number;
  /** Distinct titles seen at this employer, most common first. */
  titles: { title: string; count: number }[];
  /** How many of them Apollo holds a verified email for. */
  reachable: number;
};

export type MapResult = {
  companies: CompanyRow[];
  /** People counted across every page fetched. */
  sampled: number;
  /** Sampled people whose record carried no employer. */
  unattributed: number;
  distinctCompanies: number;
};

/**
 * Apollo reads these as query parameters even though the request is a POST,
 * and repeats array values under a `[]` suffix.
 */
export function buildSearchParams(q: MapQuery): URLSearchParams {
  const p = new URLSearchParams();
  for (const t of q.titles) p.append("person_titles[]", t);

  const locationKey =
    q.locationMode === "organization"
      ? "organization_locations[]"
      : "person_locations[]";
  for (const l of q.locations) p.append(locationKey, l);

  for (const s of q.seniorities) p.append("person_seniorities[]", s);
  for (const r of q.employeeRanges) {
    p.append("organization_num_employees_ranges[]", r);
  }

  // Only worth sending when turning the default off; sending "true" is noise
  // in the cache key and in the logs.
  if (!q.exactTitles) p.append("include_similar_titles", "true");
  else p.append("include_similar_titles", "false");

  p.append("page", String(q.page));
  p.append("per_page", String(q.perPage));
  return p;
}

/** Collapse whitespace so "Acme  Inc" and "Acme Inc" are one employer. */
function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Group people by employer.
 *
 * Grouping is case-insensitive because Apollo is not consistent about casing,
 * but the label shown is the spelling seen most often rather than a lowercased
 * one — a market map that renders "acme health" reads as a bug.
 */
export function aggregate(people: ApolloPerson[]): MapResult {
  type Bucket = {
    spellings: Map<string, number>;
    people: number;
    reachable: number;
    titles: Map<string, number>;
  };
  const buckets = new Map<string, Bucket>();
  let unattributed = 0;

  for (const person of people) {
    const raw = person.organization?.name;
    const name = typeof raw === "string" ? tidy(raw) : "";
    if (!name) {
      unattributed += 1;
      continue;
    }

    const key = name.toLowerCase();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        spellings: new Map(),
        people: 0,
        reachable: 0,
        titles: new Map(),
      };
      buckets.set(key, bucket);
    }

    bucket.people += 1;
    bucket.spellings.set(name, (bucket.spellings.get(name) ?? 0) + 1);
    if (person.has_email) bucket.reachable += 1;

    const title = typeof person.title === "string" ? tidy(person.title) : "";
    if (title) bucket.titles.set(title, (bucket.titles.get(title) ?? 0) + 1);
  }

  const sampled = people.length;
  const byCount = (a: { count: number }, b: { count: number }) =>
    b.count - a.count;

  const companies: CompanyRow[] = [...buckets.values()].map((bucket) => {
    const spelling =
      [...bucket.spellings.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    return {
      name: spelling,
      people: bucket.people,
      share: sampled ? bucket.people / sampled : 0,
      reachable: bucket.reachable,
      titles: [...bucket.titles.entries()]
        .map(([title, count]) => ({ title, count }))
        .sort(byCount),
    };
  });

  // Ties broken by name so the same search twice running gives the same order —
  // Map iteration order would otherwise leak the order Apollo happened to
  // return people in.
  companies.sort((a, b) => b.people - a.people || a.name.localeCompare(b.name));

  return {
    companies,
    sampled,
    unattributed,
    distinctCompanies: companies.length,
  };
}

/** One row per company, for pasting into a sheet. */
export function toCsv(result: MapResult): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [["Company", "People", "Share", "With email", "Titles seen"]];
  for (const c of result.companies) {
    rows.push([
      c.name,
      String(c.people),
      (c.share * 100).toFixed(1) + "%",
      String(c.reachable),
      c.titles.map((t) => `${t.title} (${t.count})`).join("; "),
    ]);
  }
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}
