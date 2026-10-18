import { get, param, query, route, toInt } from "@toyz/yerd";

const users = new Map([
  [7, { name: "Ada", posts: ["on engines", "notes on notes"] }],
  [8, { name: "Grace", posts: ["moths"] }],
]);

async function Posts({ titles }: { titles: string[] }) {
  // pretend this hits a database; the page top streams before it resolves
  await new Promise((r) => setTimeout(r, 50));
  return <ul>{titles.map((t) => <li>{t}</li>)}</ul>;
}

@route("/users/:id")
export class UserPage {
  @param("id", { transform: toInt }) accessor id!: number;
  @query("tab") accessor tab = "posts";

  @get
  show() {
    const user = users.get(this.id);
    if (!user) return 404;
    return (
      <main>
        <h1>{user.name}</h1>
        <p>tab: {this.tab}</p>
        <Posts titles={user.posts} />
      </main>
    );
  }
}
