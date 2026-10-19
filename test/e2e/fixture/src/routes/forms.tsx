import { Conflict, Region, action, between, get, is, length, route, type Action, type ActionForm } from "@toyz/yerd";

class Profile {
  @is.string({ validate: length(2, 20) }) name!: string;
  @is.email() email!: string;
  @is.array(is.int({ validate: between(1, 9) })) seats!: number[];
}

function Sent({ id, n, label }: { id: string; n: number; label: string }) {
  return (
    <Region id={id} as="p">
      {label} {n}
    </Region>
  );
}

/** A form whose next submit says how many came before: the count rides in the action's arguments. */
function ConfirmForm({ n, send }: { n: number; send: Action<{ n: number }> }) {
  return (
    <Region id="confirm-box">
      <form action={() => send({ n: n + 1 })} data-yx-confirm="Really send it?">
        <button>Send with confirmation</button>
      </form>
      <Sent id="confirmed" n={n} label="Confirmed sends:" />
    </Region>
  );
}

/**
 * The form helpers: confirm, reset, submit on change, where error messages
 * go, the busy state, and a form in a <details> closing once it's done.
 */
@route("/forms", { meta: { title: "Forms" } })
export class FormsPage {
  @get page() {
    return (
      <>
        <h1>Forms</h1>

        <ConfirmForm n={0} send={this.confirmed} />
        <button action={() => this.pinged({ n: 1 })} data-yx-confirm="Ping the server?">
          Ping with confirmation
        </button>
        <Region id="pinged" as="p" />

        <form action={this.addTag} data-yx-reset>
          <label for="tag">Tag</label> <input id="tag" name="tag" />
          <button>Add tag</button>
        </form>
        <Region id="tags" as="ul" />

        <form action={this.toggle}>
          <label>
            <input type="checkbox" name="notify" data-yx-submit /> Notify me
          </label>
        </form>
        <Region id="notify-state" as="p">
          Notifications off
        </Region>

        <form action={this.profile} id="profile" novalidate>
          <p>
            <label for="name">Name</label> <input id="name" name="name" />
            <span class="error" data-yx-error="name"></span>
          </p>
          <p>
            <label for="email">Email</label> <input id="email" name="email" />
          </p>
          <fieldset>
            <legend>Seats</legend>
            <label for="seat-1">First seat</label> <input id="seat-1" name="seats" value="1" />
            <label for="seat-2">Second seat</label> <input id="seat-2" name="seats" value="2" />
            <span class="error" data-yx-error="seats"></span>
          </fieldset>
          <p class="error" role="alert" data-yx-error></p>
          <button>Save profile</button>
        </form>
        <Region id="profile-saved" as="p" />

        <form action={this.conflict}>
          <p class="error" role="alert" data-yx-error></p>
          <button>Cause a conflict</button>
        </form>

        <button action={this.fail}>Fail without a box</button>

        <form action={this.slow}>
          <button>Save slowly</button>
          <button type="button">Another button</button>
        </form>
        <Region id="slow-done" as="p" />

        <details id="editor" open>
          <summary>Editor</summary>
          <form action={this.rename}>
            <label for="title">Title</label> <input id="title" name="title" />
            <button>Rename</button>
          </form>
        </details>
        <Region id="title-shown" as="p">
          Untitled
        </Region>
      </>
    );
  }

  @action confirmed({ n }: { n: number }) {
    return <ConfirmForm n={n} send={this.confirmed} />;
  }

  @action pinged({ n }: { n: number }) {
    return <Sent id="pinged" n={n} label="Pings:" />;
  }

  @action addTag(_: {}, form: ActionForm) {
    return (
      <Region id="tags" as="ul" append>
        <li>{form.string("tag")}</li>
      </Region>
    );
  }

  @action toggle(_: {}, form: ActionForm) {
    return (
      <Region id="notify-state" as="p">
        Notifications {form.has("notify") ? "on" : "off"}
      </Region>
    );
  }

  /** parse() throws ValidationFailed: the runtime puts each issue by its field. */
  @action profile(_: {}, form: ActionForm) {
    const profile = form.parse(Profile);
    return (
      <Region id="profile-saved" as="p">
        Saved {profile.name}, {profile.email}, seats {profile.seats.join(" and ")}
      </Region>
    );
  }

  @action conflict(): never {
    throw new Conflict("That clashes with something.");
  }

  @action fail(): never {
    throw new Conflict("Nowhere to put this message.");
  }

  @action slow() {
    return (
      <Region id="slow-done" as="p">
        Saved slowly
      </Region>
    );
  }

  @action rename(_: {}, form: ActionForm) {
    return (
      <Region id="title-shown" as="p">
        {form.string("title")}
      </Region>
    );
  }
}
