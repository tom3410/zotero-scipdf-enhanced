// Synthetic local verification, not a third-party CAPTCHA.
const http = require("node:http");
const requests = [];
http
  .createServer((req, res) => {
    const url = req.url;
    console.log(req.method, url);
    requests.push({
      url,
      cookie: req.headers.cookie || "",
      referrer: req.headers.referer || "",
    });
    const ok = (req.headers.cookie || "").includes("scipdf_fixture=verified");
    const redirect = (target) => {
      res.writeHead(302, { Location: target });
      res.end();
    };
    const html = (text, status = 200) => {
      res.writeHead(status, { "Content-Type": "text/html;charset=utf-8" });
      res.end(`<html><body>${text}</body></html>`);
    };
    if (url.startsWith("/start/")) return redirect("/client");
    if (url === "/client")
      return html(`<script>location.href='/verify';</script>`);
    if (url === "/verify")
      return ok
        ? redirect("/result/article")
        : html(
            `<h1>Local test verification</h1><form action='/confirm'><input id='human-checkbox' type='checkbox' required/><button id='confirm'>Continue</button></form>`,
            403,
          );
    if (url === "/confirm") {
      res.writeHead(302, {
        "Set-Cookie": "scipdf_fixture=verified; Path=/; HttpOnly; SameSite=Lax",
        Location: "/result/article",
      });
      res.end();
      return;
    }
    if (url === "/result/article")
      return ok
        ? html(`<iframe id='pdf' src='../files/paper.pdf'></iframe>`)
        : redirect("/verify");
    if (url === "/files/paper.pdf") {
      if (!ok || !req.headers.referer?.endsWith("/result/article"))
        return html("Verification needed", 403);
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(
        "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF",
      );
      return;
    }
    if (url === "/download/fixture.pdf") {
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="fixture.pdf"',
      });
      res.end(
        "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF",
      );
      return;
    }
    if (url === "/requests") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(requests));
      return;
    }
    if (url.startsWith("/cancel/"))
      return html("<h1>Waiting for manual verification</h1>", 403);
    res.writeHead(404);
    res.end();
  })
  .listen(18769, "127.0.0.1", () => console.log("verification fixture ready"));
