// Visual check: seeds a few todos and screenshots each layout. Usage: node test/e2e/screenshots.mjs <baseURL> <outDir>
import { chromium } from "@playwright/test";
const [base, out] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome" });
const seed = async (page) => {
  for (const title of ["Buy oat milk", "Call the plumber about the kitchen sink", "Ship yerd 0.1", "Water the plants"]) {
    await page.request.post(`${base}/api/todos`, { data: { title } });
  }
  const { todos } = await (await page.request.get(`${base}/api/todos`)).json();
  return todos;
};
const shot = async (name, { width = 1100, height = 760, scheme = "light", signedIn = true } = {}, go) => {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 1, storageState: signedIn ? storageState : undefined });
  const page = await context.newPage();
  await go(page);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  await context.close();
};
// Sign up once; every screenshot context reuses the session cookie.
const setupContext = await browser.newContext();
const setup = await setupContext.newPage();
await setup.goto(`${base}/signup`);
await setup.getByLabel("Username").fill("ada");
await setup.getByLabel(/^Password/).fill("correct horse battery");
await setup.getByRole("button", { name: "Sign up" }).click();
await setup.waitForURL(/\/todos$/);
const storageState = await setupContext.storageState();
const todos = await seed(setup);
// mark one done via the UI
await setup.goto(`${base}/todos`);
await setup.getByRole("button", { name: 'Mark "Ship yerd 0.1" as done' }).click();
await setup.waitForTimeout(200);
await shot("list-light", {}, (p) => p.goto(`${base}/todos`));
await shot("list-dark", { scheme: "dark" }, (p) => p.goto(`${base}/todos`));
await shot("list-mobile", { width: 375, height: 760 }, async (p) => {
  await p.goto(`${base}/todos`);
  await p.locator(".todo", { hasText: "Water the plants" }).getByText("Rename").click();
});
await shot("detail", {}, (p) => p.goto(`${base}/todos/${todos[1].id}`));
await shot("about", {}, (p) => p.goto(`${base}/about`));
await shot("not-found", { scheme: "dark" }, (p) => p.goto(`${base}/nope`));
await shot("login", { signedIn: false }, async (p) => {
  await p.goto(`${base}/login?next=%2Ftodos`);
  await p.getByLabel("Username").fill("ada");
  await p.getByLabel("Password").fill("wrong password");
  await p.getByRole("button", { name: "Log in" }).click();
  await p.getByRole("alert").filter({ hasText: "Wrong" }).waitFor();
});
await browser.close();
console.log("done");
