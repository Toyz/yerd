import { Region, action, get, route, session, type Session } from "@toyz/yerd";

/** What this page keeps in the visitor's session. No cookie until it changes. */
class Visit {
  clicks = 0;
}

/** The count, as a Region: the action sends back just this. */
function Clicks({ count }: { count: number }) {
  return (
    <Region id="clicks" as="p" class="mt-8 tabular-nums text-stone-500 dark:text-stone-400">
      Clicked {count} {count === 1 ? "time" : "times"}
    </Region>
  );
}

@route("/", { meta: { title: "Home" } })
export class Home {
  @session(Visit) accessor visit!: Session<Visit>;

  @get page() {
    return (
      <>
        <h1 class="text-4xl font-bold tracking-tight sm:text-5xl">
          Hello from <span class="text-orange-600">yerd</span>
        </h1>
        <p class="mt-4 text-lg text-stone-600 dark:text-stone-400">
          Edit <code class="font-mono text-base">src/routes/home.tsx</code> and save to see it change.
        </p>
        <Clicks count={this.visit.clicks} />
        {/* Posts without a reload when the runtime is loaded, as a plain form when it isn't. */}
        <form class="mt-3" action={this.click}>
          <button class="rounded-lg bg-orange-600 px-4 py-2 font-semibold text-white shadow-sm transition hover:bg-orange-500 active:translate-y-px">
            Click
          </button>
        </form>
        <p class="mt-10">
          <a class="text-orange-700 underline dark:text-orange-400" href="https://toyz.github.io/yerd/">Read the guides</a>
        </p>
      </>
    );
  }

  @action click() {
    this.visit.clicks++;
    return <Clicks count={this.visit.clicks} />;
  }
}
