// Local, controlled test pages for the pi-ego-browser test suite.
// Nothing here talks to the network: the server binds 127.0.0.1 on a free port
// and prints `LISTENING <port>` on stdout so tests can pick it up.
import { createServer } from "node:http";

const PAGES = {
  "/": `<!doctype html>
<html><head><meta charset="utf-8"><title>Pi Ego Fixture Home</title></head>
<body>
  <h1>Pi Ego fixture</h1>
  <p id="intro">A local page for browser extension tests.</p>
  <nav>
    <a href="/form.html">Open the form</a>
    <a href="/second.html">Second page</a>
  </nav>
  <button id="bump" type="button">Bump counter</button>
  <p>Counter: <span id="counter" data-count="0">0</span></p>
  <script>
    let count = 0;
    document.getElementById("bump").addEventListener("click", () => {
      count += 1;
      const node = document.getElementById("counter");
      node.textContent = String(count);
      node.dataset.count = String(count);
    });
  </script>
</body></html>`,
  "/form.html": `<!doctype html>
<html><head><meta charset="utf-8"><title>Pi Ego Fixture Form</title></head>
<body>
  <h1>Controlled form</h1>
  <form id="signup" onsubmit="event.preventDefault(); document.getElementById('outcome').textContent = 'submitted'">
    <label for="name">Full name</label>
    <input id="name" name="name" type="text" autocomplete="off">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="off">
    <label for="country">Country</label>
    <select id="country" name="country">
      <option value="">Choose</option>
      <option value="cn">China</option>
      <option value="se">Sweden</option>
      <option value="jp">Japan</option>
    </select>
    <label for="notes">Notes</label>
    <textarea id="notes" name="notes" rows="3"></textarea>
    <label><input id="agree" name="agree" type="checkbox"> Accept the fixture terms</label>
    <button id="submit" type="submit">Sign up</button>
  </form>
  <p>Outcome: <span id="outcome">pending</span></p>
  <p>Fields: <span id="fieldstate">-</span></p>
  <p id="user-slot">original</p>
  <script>
    const fields = ["name", "email", "country", "notes", "agree"];
    const render = () => {
      document.getElementById("fieldstate").textContent = fields
        .map((id) => {
          const node = document.getElementById(id);
          if (!node) return id + "=?";
          if (node.type === "checkbox") return id + "=" + (node.checked ? "yes" : "no");
          return id + "=" + JSON.stringify(node.value);
        })
        .join(" ");
    };
    for (const id of fields) {
      const node = document.getElementById(id);
      node.addEventListener("input", render);
      node.addEventListener("change", render);
    }
    // A hook the "user" edits by hand during the hand-off test.
    document.getElementById("user-slot").addEventListener("click", () => {
      document.getElementById("user-slot").textContent = "edited by user";
    });
    render();
  </script>
</body></html>`,
  "/second.html": `<!doctype html>
<html><head><meta charset="utf-8"><title>Pi Ego Fixture Second</title></head>
<body><h1>Second page</h1>
<a href="/third.html">Go to third</a>
<button id="note" type="button">Second button</button></body></html>`,
  "/third.html": `<!doctype html>
<html><head><meta charset="utf-8"><title>Pi Ego Fixture Third</title></head>
<body><h1>Third page</h1><p id="third">third page body</p></body></html>`,
};

export function startFixtureServer(port = 0) {
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const body = PAGES[url.pathname];
    if (!body) {
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end("<h1>not found</h1>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const { port } = await startFixtureServer(Number(process.argv[2]) || 0);
  process.stdout.write(`LISTENING ${port}\n`);
}