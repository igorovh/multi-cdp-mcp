/** Reports sign-in indicators only; never reads page text, cookie values or account data. */
import { CdpClient } from "../src/browser/cdp.ts";

interface SiteState {
  site: string;
  loggedInIndicator: boolean;
  loggedOutIndicator: boolean;
  details: Record<string, boolean>;
}

async function endpoint(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  const info = (await response.json()) as { webSocketDebuggerUrl: string };
  return info.webSocketDebuggerUrl;
}

async function inspect(client: CdpClient, site: "twitch" | "kick"): Promise<SiteState> {
  const url = site === "twitch" ? "https://www.twitch.tv/" : "https://kick.com/";
  const { targetId } = await client.send<{ targetId: string }>("Target.createTarget", { url });
  try {
    await Bun.sleep(12_000);
    const sessionId = await client.attach(targetId);
    if (site === "twitch") {
      return await client.evaluate<SiteState>(
        sessionId,
        `(() => {
          const userMenu = !!document.querySelector('[data-a-target="user-menu-toggle"]');
          const loginButton = !!document.querySelector('[data-a-target="login-button"]');
          return {
            site: 'twitch.tv',
            loggedInIndicator: userMenu,
            loggedOutIndicator: loginButton,
            details: { userMenu, loginButton }
          };
        })()`,
      );
    }
    return await client.evaluate<SiteState>(
      sessionId,
      `(() => {
        const buttonLabels = [...document.querySelectorAll('button,a')]
          .map((element) => (element.textContent || '').trim().toLowerCase());
        const signIn = buttonLabels.some((text) => text === 'sign in' || text === 'log in');
        const userMenu = !!document.querySelector(
          '[data-testid*="user-menu"], [data-testid*="avatar"], button[aria-label*="rofile" i], button[aria-label*="ccount" i]'
        );
        return {
          site: 'kick.com',
          loggedInIndicator: userMenu && !signIn,
          loggedOutIndicator: signIn,
          details: { userMenu, signIn }
        };
      })()`,
    );
  } finally {
    await client.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

for (const port of [9222, 9223]) {
  const client = await CdpClient.connect(await endpoint(port));
  try {
    console.log(JSON.stringify({ environment: port, twitch: await inspect(client, "twitch") }));
    console.log(JSON.stringify({ environment: port, kick: await inspect(client, "kick") }));
  } finally {
    client.close();
  }
}
