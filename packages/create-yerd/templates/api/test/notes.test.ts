import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import "../src/routes/notes.js";

// The app main.ts serves, with the routes this file imports. No port is opened.
const app = createApp({ handleSignals: false });
beforeAll(() => app.boot());
afterAll(() => app.stop());

/** A JSON request. */
function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("notes", () => {
  it("lists notes as JSON", async () => {
    const res = await app.request("/api/notes");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toMatchObject([{ id: 1, title: "Read the yerd guides" }]);
  });

  it("creates a note with 201, filling in defaults", async () => {
    const res = await send("POST", "/api/notes", { title: "  Write tests  " });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 2, title: "Write tests", body: "", done: false });
  });

  it("reports every invalid field at once", async () => {
    const res = await send("POST", "/api/notes", { title: "", done: "maybe" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ issues: [{ path: "title", message: "Can't be empty" }, { path: "done" }] });
  });

  it("refuses a duplicate title with a code", async () => {
    const res = await send("POST", "/api/notes", { title: "read the yerd guides" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "duplicate_title" });
  });

  it("replaces, filters and deletes", async () => {
    const created = (await (await send("POST", "/api/notes", { title: "Deploy" })).json()) as { id: number };

    const replaced = await send("PUT", `/api/notes/${created.id}`, { title: "Deploy", done: true });
    expect(await replaced.json()).toMatchObject({ id: created.id, done: true });
    expect(await (await app.request("/api/notes?done=true")).json()).toMatchObject([{ id: created.id }]);

    const removed = await send("DELETE", `/api/notes/${created.id}`);
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe("");
  });

  it("is a 404 with the id for an unknown note, and a 400 for a bad one", async () => {
    const missing = await app.request("/api/notes/99");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "No note 99", code: "not_found", id: 99 });

    expect((await app.request("/api/notes/abc")).status).toBe(400);
  });

  it("answers health checks with 204", async () => {
    expect((await app.request("/api/health")).status).toBe(204);
  });
});
