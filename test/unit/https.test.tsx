// listen({ tls }): HTTPS with the same lifecycle as HTTP, and the request seen as https everywhere.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { currentContext, get, route, session, yerd, type Session } from "@toyz/yerd";

/** A self-signed certificate for localhost, made for this run; undefined where openssl isn't installed. */
function selfSigned(): { key: Buffer; cert: Buffer; dir: string } | undefined {
  const dir = mkdtempSync(join(tmpdir(), "yerd-tls-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    ], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")), dir };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
}

const tls = selfSigned();
afterAll(() => {
  if (tls) rmSync(tls.dir, { recursive: true, force: true });
});

@route("/remember")
class Remember {
  @session accessor session!: Session<{ seen?: boolean }>;
  @get page() {
    this.session.seen = true;
    return "ok";
  }
}

@route("/where")
class Where {
  @get page() {
    const ctx = currentContext();
    return { url: ctx.url.href, ip: ctx.ip };
  }
}

/** GET over HTTPS, trusting only our certificate. */
function fetchTls(url: string, ca: Buffer): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    request(url, { ca }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on("error", reject).end();
  });
}

describe.skipIf(!tls)("listen({ tls })", () => {
  it("serves HTTPS: an https url, ctx.url, HSTS and Secure session cookies", async () => {
    const app = yerd({ routes: [Where, Remember], services: [], handleSignals: false }).sessions().securityHeaders();
    await using server = await app.listen(0, "127.0.0.1", { tls: { key: tls!.key, cert: tls!.cert } });
    expect(server.url).toBe(`https://127.0.0.1:${server.port}`);
    const r = await fetchTls(`${server.url}/where`, tls!.cert);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ url: `https://127.0.0.1:${server.port}/where`, ip: "127.0.0.1" });
    expect(r.headers["strict-transport-security"]).toBe("max-age=31536000");
    const cookie = String((await fetchTls(`${server.url}/remember`, tls!.cert)).headers["set-cookie"]);
    expect(cookie).toMatch(/^__Host-/);
    expect(cookie).toContain("; Secure");
  });

  it("closes gracefully, like HTTP", async () => {
    const server = await yerd({ routes: [Where], services: [], handleSignals: false }).listen(0, "127.0.0.1", { tls: { key: tls!.key, cert: tls!.cert } });
    await fetchTls(`${server.url}/where`, tls!.cert);
    await server.close();
    expect(server.server.listening).toBe(false);
  });
});

describe("listen({ tls }) without a certificate", () => {
  it("throws before starting anything", async () => {
    const app = yerd({ routes: [], services: [], handleSignals: false });
    await expect(app.listen(0, "127.0.0.1", { tls: {} })).rejects.toThrow("listen({ tls }) needs a certificate");
    await expect(app.listen(0, "127.0.0.1", { tls: { cert: "only a cert" } })).rejects.toThrow("needs a certificate");
    // Nothing was started, so the app still listens over HTTP.
    await using server = await app.listen(0, "127.0.0.1");
    expect(server.url.startsWith("http://")).toBe(true);
  });
});
