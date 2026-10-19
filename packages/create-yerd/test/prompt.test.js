import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { CancelError, createPrompter } from "../src/prompt.js";
import { createStyle } from "../src/style.js";

const style = createStyle(false);
const choices = [
  { value: "full", label: "Full app", hint: "everything" },
  { value: "minimal", label: "Minimal" },
  { value: "api", label: "API only" },
];

/** A writable that keeps what was written. */
function sink() {
  const stream = new Writable({
    write(chunk, _encoding, done) {
      stream.text += chunk;
      done();
    },
  });
  stream.text = "";
  return stream;
}

/** Piped input: the given lines, then the end. */
function lines(...answers) {
  const input = new PassThrough();
  input.end(answers.map((a) => `${a}\n`).join(""));
  return input;
}

describe("without a terminal: one question per line", () => {
  it("is what you get when input isn't a TTY", async () => {
    const output = sink();
    const prompter = createPrompter({ input: lines("my-app"), output, style });
    assert.equal(await prompter.text({ message: "Project directory:", initial: "yerd-app" }), "my-app");
    assert.equal(output.text, "Project directory: (yerd-app): ");
    prompter.close();
  });

  it("takes the default for an empty line, and for every question once input ends", async () => {
    const prompter = createPrompter({ input: lines(""), output: sink(), style });
    assert.equal(await prompter.text({ message: "Name:", initial: "yerd-app" }), "yerd-app");
    assert.equal(await prompter.select({ message: "Template:", choices, initial: "minimal" }), "minimal");
    assert.equal(await prompter.confirm({ message: "Git?", initial: true }), true);
    assert.equal(await prompter.confirm({ message: "Tailwind?", initial: false }), false);
    prompter.close();
  });

  it("picks a choice by number, value or label, and asks again for anything else", async () => {
    const output = sink();
    const prompter = createPrompter({ input: lines("3", "full", "minimal", "nope", "Full app"), output, style });
    assert.equal(await prompter.select({ message: "Template:", choices }), "api");
    assert.equal(await prompter.select({ message: "Template:", choices }), "full");
    assert.equal(await prompter.select({ message: "Template:", choices }), "minimal");
    assert.equal(await prompter.select({ message: "Template:", choices }), "full");
    assert.match(output.text, /1\) Full app - everything\n {2}2\) Minimal\n {2}3\) API only/);
    assert.match(output.text, /Pick 1-3 or one of: full, minimal, api/);
    prompter.close();
  });

  it("reads y, yes, n and no, and asks again for anything else", async () => {
    const output = sink();
    const prompter = createPrompter({ input: lines("y", "NO", "maybe", "yes"), output, style });
    assert.equal(await prompter.confirm({ message: "A?" }), true);
    assert.equal(await prompter.confirm({ message: "B?" }), false);
    assert.equal(await prompter.confirm({ message: "C?", initial: false }), true);
    assert.match(output.text, /Answer y or n/);
    prompter.close();
  });

  it("validates text, asking again", async () => {
    const output = sink();
    const prompter = createPrompter({ input: lines("a|b", "ok"), output, style });
    const validate = (v) => (v.includes("|") ? "No pipes" : undefined);
    assert.equal(await prompter.text({ message: "Dir:", validate }), "ok");
    assert.match(output.text, /No pipes/);
    prompter.close();
  });
});

/** A fake terminal: keys go in, frames come out. */
function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (on) => {
    input.isRaw = on;
  };
  const output = sink();
  output.isTTY = true;
  return { input, output, prompter: createPrompter({ input, output, style }) };
}

describe("in a terminal: raw mode", () => {
  it("moves through a select with the arrow keys and picks with enter", async () => {
    const { input, output, prompter } = terminal();
    const answer = prompter.select({ message: "Template:", choices, initial: "full" });
    input.write("\x1b[B"); // down
    input.write("\x1b[B"); // down
    input.write("\x1b[A"); // up
    input.write("\r");
    assert.equal(await answer, "minimal");
    assert.equal(input.isRaw, false, "raw mode is restored");
    assert.match(output.text, /\+ Template: Minimal\n$/);
  });

  it("wraps around the ends of a select", async () => {
    const { input, prompter } = terminal();
    const answer = prompter.select({ message: "Template:", choices });
    input.write("\x1b[A\r");
    assert.equal(await answer, "api");
  });

  it("types text, with backspace, and falls back to the default when empty", async () => {
    const { input, output, prompter } = terminal();
    const typed = prompter.text({ message: "Dir:", initial: "yerd-app" });
    input.write("my-apx");
    input.write("\x7f"); // backspace
    input.write("p\r");
    assert.equal(await typed, "my-app");
    assert.match(output.text, /\+ Dir: my-app\n$/);

    const empty = prompter.text({ message: "Dir:", initial: "yerd-app" });
    input.write("\r");
    assert.equal(await empty, "yerd-app");
  });

  it("keeps asking while the text is invalid", async () => {
    const { input, output, prompter } = terminal();
    const typed = prompter.text({ message: "Dir:", validate: (v) => (v === "bad" ? "Not that one" : undefined) });
    input.write("bad\r");
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(output.text, /Not that one/);
    input.write("\x7f\x7f\x7fgood\r");
    assert.equal(await typed, "good");
  });

  it("answers a confirm with y, n or enter for the default", async () => {
    const { input, prompter } = terminal();
    const yes = prompter.confirm({ message: "Git?", initial: false });
    input.write("y");
    assert.equal(await yes, true);
    const no = prompter.confirm({ message: "Git?" });
    input.write("n");
    assert.equal(await no, false);
    const fallback = prompter.confirm({ message: "Git?", initial: false });
    input.write("\r");
    assert.equal(await fallback, false);
  });

  it("cancels on Ctrl-C", async () => {
    const { input, prompter } = terminal();
    const answer = prompter.text({ message: "Dir:" });
    input.write("\x03");
    await assert.rejects(answer, CancelError);
    assert.equal(input.isRaw, false);
  });
});
