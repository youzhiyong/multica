import { describe, it, expect, afterEach, vi } from "vitest";
import { deriveWsUrl } from "./runtime-urls";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deriveWsUrl", () => {
  it("uses the configured NEXT_PUBLIC_WS_URL when present", () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "wss://api.example.com/ws");
    expect(deriveWsUrl({ protocol: "http:", host: "app.example.com" })).toBe(
      "wss://api.example.com/ws",
    );
  });

  it("derives a ws:// URL from the page origin when the env var is empty", () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
    expect(deriveWsUrl({ protocol: "http:", host: "192.168.1.20:3000" })).toBe(
      "ws://192.168.1.20:3000/ws",
    );
  });

  it("derives a wss:// URL for https deployments", () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
    expect(deriveWsUrl({ protocol: "https:", host: "app.example.com" })).toBe(
      "wss://app.example.com/ws",
    );
  });

  it("derives from the current window when no location is passed", () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "");
    expect(deriveWsUrl()).toBe(`ws://${window.location.host}/ws`);
  });
});
