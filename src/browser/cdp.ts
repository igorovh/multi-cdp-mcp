export interface CdpTarget {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { message: string };
  method?: string;
  params?: unknown;
  sessionId?: string;
}

interface EvaluateResult<T> {
  result?: { value?: T };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/** Minimal CDP client with flat session routing, enough to drive targets directly. */
export class CdpClient {
  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#onMessage(String(event.data)));
    socket.addEventListener("close", () => this.#failAll(new Error("CDP connection closed")));
    socket.addEventListener("error", () => this.#failAll(new Error("CDP connection error")));
  }

  static connect(webSocketUrl: string, timeoutMs = 15_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(webSocketUrl);
      } catch (error) {
        reject(error as Error);
        return;
      }
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`CDP connection to ${webSocketUrl} timed out`));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpClient(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`CDP connection to ${webSocketUrl} failed`));
      });
    });
  }

  #onMessage(raw: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  #failAll(error: Error): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  send<T>(method: string, params: object = {}, sessionId?: string, timeoutMs = 20_000): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("CDP client is closed"));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async getTargets(): Promise<CdpTarget[]> {
    const { targetInfos } = await this.send<{ targetInfos: CdpTarget[] }>("Target.getTargets");
    return targetInfos;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  async extensionWorkers(): Promise<CdpTarget[]> {
    const targets = await this.getTargets();
    return targets.filter(
      (target) => target.type === "service_worker" && target.url.startsWith("chrome-extension://"),
    );
  }

  /** Attaching also keeps an extension service worker from going dormant. */
  async attach(targetId: string): Promise<string> {
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return sessionId;
  }

  async evaluate<T>(
    sessionId: string,
    expression: string,
    options: { userGesture?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const result = await this.send<EvaluateResult<T>>(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: options.userGesture ?? true,
      },
      sessionId,
      options.timeoutMs,
    );
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description ?? details.text ?? "Evaluation failed");
    }
    return result.result?.value as T;
  }

  close(): void {
    this.#closed = true;
    try {
      this.#socket.close();
    } catch {
      // Already closing.
    }
  }
}
