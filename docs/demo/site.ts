/** Local test site for the demo: a tiny shop and a CRM with a cookie login. Fake data only. */
const PORT = Number(process.env.DEMO_SITE_PORT ?? 4173);

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<style>body{font:16px system-ui;margin:40px}button,input{font:inherit;margin:4px}</style>${body}`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function cookies(request: Request): Record<string, string> {
  return Object.fromEntries(
    (request.headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const jar = cookies(request);

    if (url.pathname === "/shop") {
      return page(
        "Acme Shop",
        `<h1>Acme Shop</h1><p>Acme Rocket Skates — $49</p>
<button id="add" onclick="document.cookie='cart='+(Number(document.cookie.match(/cart=(\\d+)/)?.[1]??0)+1)+';path=/';location.reload()">Add to cart</button>
<p id="cart">Cart: ${jar.cart ?? 0} item(s), total $${Number(jar.cart ?? 0) * 49}</p>`,
      );
    }
    if (url.pathname === "/crm/login" && request.method === "POST") {
      const form = await request.formData();
      if (form.get("email") === "dana@acme.test" && form.get("password") === "demo123") {
        return new Response(null, {
          status: 303,
          headers: { location: "/crm/dashboard", "set-cookie": "crm_session=dana; path=/; max-age=86400" },
        });
      }
      return page("Acme CRM · Sign in", "<h1>Wrong email or password</h1><a href='/crm/login'>Try again</a>");
    }
    if (url.pathname === "/crm/login") {
      return page(
        "Acme CRM · Sign in",
        `<h1>Acme CRM</h1><form method="post">
<label>Email <input name="email" type="email"></label><br>
<label>Password <input name="password" type="password"></label><br>
<button type="submit">Sign in</button></form>`,
      );
    }
    if (url.pathname === "/crm/dashboard") {
      if (jar.crm_session !== "dana") return Response.redirect(`http://127.0.0.1:${PORT}/crm/login`, 303);
      return page("Acme CRM · Dashboard", "<h1>Welcome back, Dana!</h1><p>3 open deals · 1 overdue task</p>");
    }
    return page("Acme", `<h1>Acme</h1><a href="/shop">Shop</a> · <a href="/crm/login">CRM</a>`);
  },
});
console.log(`demo site on http://127.0.0.1:${PORT}`);
