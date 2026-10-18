// The floor: raw node:http doing the same plain/json work, no framework.
import { createServer } from "node:http";
const json = JSON.stringify({ hello: "world", n: 42, list: [1, 2, 3] });
createServer((req, res) => {
  if (req.url === "/plain") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": "11" });
    res.end("hello world");
  } else if (req.url === "/json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(json)) });
    res.end(json);
  } else {
    res.writeHead(404).end();
  }
}).listen(Number(process.env.PORT ?? 4101), "127.0.0.1", () => console.log("baseline up"));
