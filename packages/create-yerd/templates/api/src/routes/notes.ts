import { HttpStatus, body, del, get, inject, param, post, put, query, route, status, toBool, toInt } from "@toyz/yerd";
import { NoteInput, Notes } from "../notes.js";

/** curl localhost:5173/api/notes?done=false */
@route("/api/notes")
export class NotesApi {
  @inject(Notes) accessor notes!: Notes;
  @query("done", { transform: toBool }) accessor done: boolean | undefined;
  // Read and validated only when awaited: a bad body is a 400 listing every issue.
  @body(NoteInput) accessor input!: Promise<NoteInput>;

  @get list() {
    return this.notes.list(this.done);
  }

  /** curl -X POST localhost:5173/api/notes -H 'content-type: application/json' -d '{"title":"Ship it"}' */
  @post @status(HttpStatus.Created) async create() {
    return this.notes.create(await this.input);
  }
}

@route("/api/notes/:id")
export class NoteApi {
  @inject(Notes) accessor notes!: Notes;
  // Not a number: a 400 before the handler runs.
  @param("id", { transform: toInt }) accessor id!: number;
  @body(NoteInput) accessor input!: Promise<NoteInput>;

  @get show() {
    return this.notes.find(this.id);
  }

  @put async replace() {
    return this.notes.update(this.id, await this.input);
  }

  @del remove() {
    this.notes.remove(this.id);
    return HttpStatus.NoContent;
  }
}

/** For load balancers and uptime checks: 204, no body. */
@route("/api/health")
export class Health {
  @get check() {
    return HttpStatus.NoContent;
  }
}
