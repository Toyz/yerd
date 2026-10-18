import { randomUUID } from "node:crypto";
import { is, length, service, trim, type Validator } from "@toyz/yerd";
import { toUuid, type ReturnReason, type Uuid } from "./cart.js";

const notInFuture: Validator<Date> = (date) => date.getTime() <= Date.now() || "That date hasn't happened yet";

/**
 * The guest returns form (no account needed). Every field is a different
 * validator, and `order` shows a pipeline that changes the type: `is.string`
 * checks a string, `trim` tidies it, `toUuid` turns it into a branded `Uuid`
 * (or rejects it), and the field is typed by the last step.
 */
export class ReturnRequest {
  @is.string({ transform: [trim, toUuid] }) order!: Uuid;
  @is.email() email!: string;
  @is.date({ validate: notInFuture }) received!: Date;
  @is.oneOf(["refund", "exchange", "a sincere apology"]) wants!: "refund" | "exchange" | "a sincere apology";
  /** A link to a photo of the offending gnome; only http(s), so no `javascript:` URLs. */
  @is.url({ optional: true }) evidence?: string;
  @is.string({ transform: trim, validate: length(10, 500) }) reason!: string;
}

/**
 * "Request a return" on a shipped order: a reason, a note, and up to five
 * photos (from the file input, or dropped on its staging zone first).
 */
export class OrderReturnForm {
  @is.oneOf(["damaged", "wrong item", "changed my mind", "other"]) reason!: ReturnReason;
  @is.string({ transform: trim, validate: length(10, 500) }) note!: string;
  @is.files({ optional: true, types: ["image/*"], maxSize: 1_500_000, max: 5 }) photos?: File[];
}

/** Staff look an order up by its full id on /admin/orders: `is.uuid()` lowercases and checks the format. */
export class FindOrder {
  @is.uuid({ version: 4 }) id!: string;
}

export interface ReturnTicket extends Omit<ReturnRequest, "received"> {
  id: string;
  received: string;
  at: string;
}

/** Guest return requests, in memory, for staff to read on /admin/orders. */
@service
export class Returns {
  #tickets: ReturnTicket[] = [];

  file(request: ReturnRequest): ReturnTicket {
    const ticket: ReturnTicket = { ...request, id: randomUUID(), received: request.received.toISOString().slice(0, 10), at: new Date().toISOString() };
    this.#tickets.unshift(ticket);
    return ticket;
  }

  all(): ReturnTicket[] {
    return this.#tickets;
  }
}
