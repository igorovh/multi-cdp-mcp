export interface CdpTarget {
  type: string;
  url: string;
  title: string;
}

function send<T>(webSocketUrl: string, method: string, params: object): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(webSocketUrl);
    } catch (error) {
      reject(error as Error);
      return;
    }
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`CDP ${method} timed out`));
    }, 10_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      const message = JSON.parse(String(event.data)) as {
        result?: T;
        error?: { message: string };
      };
      socket.close();
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result as T);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`CDP ${method} socket error`));
    });
  });
}

/**
 * Lists extension service workers directly over CDP. Needed because Brave does not
 * back the DevTools MCP extension tools, so list_extensions cannot prove that the
 * profile's extensions are actually running.
 */
export async function extensionWorkers(webSocketUrl: string): Promise<CdpTarget[]> {
  const { targetInfos } = await send<{ targetInfos: CdpTarget[] }>(
    webSocketUrl,
    "Target.getTargets",
    {},
  );
  return targetInfos.filter(
    (target) => target.type === "service_worker" && target.url.startsWith("chrome-extension://"),
  );
}
