import { BadRequest, Region, UnsupportedMediaType, action, get, query, route, type ActionForm } from "@toyz/yerd";

type Zone = "todo" | "done";
const CARDS = ["a", "b", "c"];

// Each test works on a board of its own (?t=...), so runs never see each other's moves.
const boards = new Map<string, Record<string, Zone>>();
function board(id: string): Record<string, Zone> {
  let found = boards.get(id);
  if (!found) boards.set(id, (found = Object.fromEntries(CARDS.map((card) => [card, "todo" as Zone]))));
  return found;
}

/**
 * Drag and drop: cards dragged between zones, files dropped from outside the
 * page (posted at once), and files staged into a form's input with dropTo.
 */
@route("/dnd", { meta: { title: "Drag and drop" } })
export class DndPage {
  @query("t") accessor t = "default";

  @get page() {
    return (
      <>
        <h1>Drag and drop</h1>
        <div class="zones">
          {this.zone("todo", "To do")}
          {this.zone("done", "Done")}
        </div>

        <div id="file-zone" class="dropzone" action={this.upload} trigger="drop:files" accept="text/plain,.md">
          Drop text files to upload them
        </div>
        <Region id="uploaded" as="ul" />

        <form action={this.post} enctype="multipart/form-data">
          <label for="attachments">Attachments</label> <input id="attachments" type="file" name="attachments" multiple accept=".txt" />
          <div id="stage" class="dropzone" dropTo="#attachments">
            Drop attachments here
          </div>
          <button>Post attachments</button>
        </form>
        <Region id="posted" as="ul" />
      </>
    );
  }

  zone(zone: Zone, label: string) {
    const cards = Object.entries(board(this.t)).filter(([, at]) => at === zone);
    return (
      <section class="zone" id={`zone-${zone}`} aria-label={label} action={({ drag }) => this.move({ card: drag.data("id"), to: zone })} trigger="drop">
        <h2>{label}</h2>
        <Region id={`cards-${zone}`} as="ul">
          {cards.map(([card]) => (
            <li key={card} data-id={card} draggable="true">
              Card {card.toUpperCase()}
            </li>
          ))}
        </Region>
      </section>
    );
  }

  @action move({ card, to }: { card: string; to: Zone }) {
    const cards = board(this.t);
    if (!(card in cards)) throw new BadRequest(`No card ${card}`);
    cards[card] = to;
    return (
      <>
        {this.zone("todo", "To do")}
        {this.zone("done", "Done")}
      </>
    );
  }

  @action async upload(_: {}, form: ActionForm) {
    const files = form.files("files");
    for (const file of files) if (!file.name.endsWith(".txt") && !file.name.endsWith(".md")) throw new UnsupportedMediaType(`${file.name} isn't text`);
    const lines = await Promise.all(files.map(async (file) => `${file.name}: ${(await file.text()).trim()}`));
    return (
      <Region id="uploaded" as="ul" append>
        {lines.map((line) => (
          <li>{line}</li>
        ))}
      </Region>
    );
  }

  @action post(_: {}, form: ActionForm) {
    return (
      <Region id="posted" as="ul">
        {form.files("attachments").map((file) => (
          <li>
            {file.name} ({file.size} bytes)
          </li>
        ))}
      </Region>
    );
  }
}
