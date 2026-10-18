import { css, get, inject, resolve, route } from "@toyz/yerd";
import { BootInfo, Dice, Disposals, Fortune, Visit } from "../lifetimes.js";
import { Shop } from "./shop.js";

const inline = css`
  display: inline;
  margin: 0;
  padding: 0;
  & li { display: inline; }
  & li + li::before { content: " · "; }
`;

/** Somewhere else in the same request: resolve() hands back the request's own Visit, not a new one. */
function SameVisit() {
  return <code id="visit-again">{resolve(Visit).id}</code>;
}

/**
 * Every way to register a service, side by side. Reload: the singleton stays,
 * the scoped Visit changes (and the last one shows up as disposed), the two
 * transient dice are always two different dice.
 */
@route("/lifetimes", { group: Shop, meta: { title: "Service lifetimes", area: "features" } })
export class Lifetimes {
  @inject(BootInfo) accessor boot!: BootInfo;
  @inject(Visit) accessor visit!: Visit;
  @inject(Dice) accessor left!: Dice;
  @inject(Dice) accessor right!: Dice;
  @inject(Fortune) accessor fortune!: Fortune;
  @inject(Disposals) accessor disposals!: Disposals;

  @get page() {
    const disposed = this.disposals.recent();
    return (
      <>
        <h1 class="page-title">Service lifetimes</h1>
        <p class="meta-line">One of each kind of service registration. Reload the page and watch what changes.</p>
        <section class="panel">
          <table class="table plain">
            <thead>
              <tr>
                <th>Lifetime</th>
                <th>Registered with</th>
                <th>On this page</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Singleton</td>
                <td><code>s.singleton(BootInfo, bootInfo)</code>: a factory for a token</td>
                <td>
                  Process <code id="boot-id">{this.boot.id}</code>, up since {this.boot.bootedAt.toLocaleTimeString("en-GB")}. The same on every reload until the server restarts.
                </td>
              </tr>
              <tr>
                <td>Scoped</td>
                <td><code>{"s.scoped(Visit, (c) => new Visit(c.get(Disposals)))"}</code>: a factory with a constructor argument</td>
                <td>
                  This request is <code id="visit-id">{this.visit.id}</code>, and a component resolving it gets <SameVisit />: one per request. New on every reload.
                </td>
              </tr>
              <tr>
                <td>Scoped, disposed</td>
                <td><code>[Symbol.dispose]()</code> on Visit</td>
                <td>
                  Run when its request ends. Visits disposed so far:{" "}
                  {disposed.length ? (
                    <ol id="disposed" class={inline}>
                      {disposed.map((d) => (
                        <li>
                          <code>{d.id}</code> after {d.ms.toFixed(1)} ms
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <span id="disposed">none yet; reload</span>
                  )}
                </td>
              </tr>
              <tr>
                <td>Transient</td>
                <td><code>@transient @service class Dice</code></td>
                <td>
                  Two <code>@inject(Dice)</code> fields, two dice: <code id="die-left">{this.left.id}</code> rolled {this.left.roll}, <code id="die-right">{this.right.id}</code> rolled {this.right.roll}.
                </td>
              </tr>
              <tr>
                <td>Singleton, by token</td>
                <td><code>{"@service({ provides: Fortune }) class GnomeFortunes"}</code></td>
                <td>
                  The page injects the <code>Fortune</code> interface's token and gets the class: <q id="fortune">{this.fortune.tell()}</q>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
        <p class="muted small">
          Elsewhere in the shop: <code>@singleton</code> Chat and Presence, the <code>@scoped</code> Viewer behind every layout, <code>@hosted</code> RestockWorker, <code>@every</code> SalesFeed, and a <code>@maybe</code> Mailer nobody registered.
        </p>
      </>
    );
  }
}
