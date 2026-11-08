import { describe, it, expect, vi, afterEach } from "vitest";
import { WSClient } from "./ws-client";
import type { Logger } from "../logger";

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WSClient", () => {
  it("logs instead of throwing when the WebSocket URL is invalid", () => {
    const logger = createLogger();
    const client = new WSClient("", { logger });

    expect(() => client.connect()).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      "invalid WebSocket URL; realtime disabled",
      "",
      expect.any(Error),
    );
  });

  it("connects with the auth token and workspace query params", () => {
    const constructed: string[] = [];
    class FakeWebSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: unknown = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        constructed.push(url);
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = new WSClient("ws://example.com/ws", { logger: createLogger() });
    client.setAuth("token-1", "ws-1");
    client.connect();

    expect(constructed).toHaveLength(1);
    const url = new URL(constructed[0]!);
    expect(url.searchParams.get("token")).toBe("token-1");
    expect(url.searchParams.get("workspace_id")).toBe("ws-1");
  });
});
