// Compile-only: action lambdas are ordinary calls, so their args are checked.
import { action, get, route, type Action, type ActionForm } from "@toyz/yerd";

@route("/todos")
export class Todos {
  @action remove({ id }: { id: string }) {
    return id;
  }

  @action rename({ id }: { id: string }, form: ActionForm) {
    return id + form.get("title");
  }

  @action add(_: {}, form: ActionForm) {
    return form.get("title");
  }

  @action search({ q, page }: { q: string; page: number }) {
    return q + page;
  }

  @get page() {
    return (
      <>
        <form action={() => this.remove({ id: "1" })} class="inline">
          <button>Delete</button>
        </form>
        {/* No args: pass the action itself. */}
        <form action={this.add}>
          <input name="title" />
        </form>
        <form action={({ form }) => this.rename({ id: "1" }, form)} />
        {/* Live values and the page's context. */}
        <input action={({ el, ctx }) => this.search({ q: el.value, page: Number(ctx.query.get("page") ?? 1) })} trigger="input 250ms" />
        <div action={({ ref }) => this.search({ q: ref("#q").value, page: 2 })} trigger="visible" />
        <button action={() => this.remove({ id: "1" })} trigger="keydown:Enter">x</button>
        <button formaction={() => this.remove({ id: "1" })}>Delete</button>
        <ul action={({ drag }) => this.remove({ id: drag.dataset.id! })} trigger="drop" />
        {/* @ts-expect-error "idd": remove takes { id } */}
        <form action={() => this.remove({ idd: "1" })} />
        {/* @ts-expect-error id must be a string */}
        <form action={() => this.remove({ id: 1 })} />
        {/* @ts-expect-error remove needs its args: pass a lambda */}
        <form action={this.remove} />
        {/* @ts-expect-error el.value is a string, page a number */}
        <input action={({ el }) => this.search({ q: el.value, page: el.value })} />
      </>
    );
  }
}

export function Counter({ id, bump }: { id: string; bump: Action<{ id: string }> }) {
  return <form action={() => bump({ id })}><button>+1</button></form>;
}
