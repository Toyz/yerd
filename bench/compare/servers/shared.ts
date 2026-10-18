// Data and helpers every server shares, so they all do the same work.

export const PORT = Number(process.env.PORT ?? 3000);
export const HOST = "127.0.0.1";

/** The token /secure accepts in `Authorization: Bearer <token>`. */
export const TOKEN = "bench-secret-token";
export const BEARER = `Bearer ${TOKEN}`;

export interface Row {
  id: number;
  title: string;
}

/** 100 rows for /page. Titles contain <, >, & and " so every renderer has to escape them. */
export const ROWS: Row[] = Array.from({ length: 100 }, (_, i) => ({
  id: i,
  title: `Row ${i}: <b>bold</b> & "quoted" text`,
}));

export interface Echo {
  name: string;
  age: number;
}

/**
 * The hand-written check Express, Koa, Hono and the node:http baseline use for POST /echo:
 * `name` must be a non-empty string and `age` a number. Returns the issue, or undefined.
 */
export function checkEcho(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return "Expected a JSON object";
  const { name, age } = body as Record<string, unknown>;
  if (typeof name !== "string" || name.length === 0) return "name: expected a non-empty string";
  if (typeof age !== "number" || !Number.isFinite(age)) return "age: expected a number";
  return undefined;
}

/** What /users/:id answers: the id as a number, `fields` split on commas. */
export function userReply(id: string, fields: string | undefined | null) {
  return { id: Number(id), fields: fields ? fields.split(",") : [] };
}
