// Compile-only: <Form>'s args are typed from its action.
import { Form, action, get, route, type Action, type ActionForm } from "@toyz/yerd";

@route("/todos")
export class Todos {
  @action remove({ id }: { id: string }) {
    return id;
  }

  @action add(_: {}, form: ActionForm) {
    return form.get("title");
  }

  @get page() {
    return (
      <>
        <Form action={this.remove} args={{ id: "1" }} class="inline">
          <button>Delete</button>
        </Form>
        {/* No args: the action takes none. */}
        <Form action={this.add}>
          <input name="title" />
        </Form>
        {/* @ts-expect-error "idd": remove takes { id } */}
        <Form action={this.remove} args={{ idd: "1" }} />
        {/* @ts-expect-error id must be a string */}
        <Form action={this.remove} args={{ id: 1 }} />
        {/* @ts-expect-error args are required: remove needs an id */}
        <Form action={this.remove} />
      </>
    );
  }
}

export function Counter({ id, bump }: { id: string; bump: Action<{ id: string }> }) {
  return <Form action={bump} args={{ id }}><button>+1</button></Form>;
}
