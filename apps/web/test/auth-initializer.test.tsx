import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { AuthInitializer } from "@multica/core/platform";
import type { StorageAdapter, User, Workspace } from "@multica/core/types";

const mocks = vi.hoisted(() => ({
  getMe: vi.fn(),
  listWorkspaces: vi.fn(),
  setToken: vi.fn(),
  setWorkspaceId: vi.fn(),
  setAuthState: vi.fn(),
  hydrateWorkspace: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({
  getApi: () => ({
    getMe: mocks.getMe,
    listWorkspaces: mocks.listWorkspaces,
    setToken: mocks.setToken,
    setWorkspaceId: mocks.setWorkspaceId,
  }),
}));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: Object.assign(() => undefined, { setState: mocks.setAuthState }),
}));

vi.mock("@multica/core/workspace", () => ({
  useWorkspaceStore: Object.assign(() => undefined, {
    getState: () => ({ hydrateWorkspace: mocks.hydrateWorkspace }),
  }),
}));

const mockUser: User = {
  id: "user-1",
  name: "Test User",
  email: "test@multica.ai",
  avatar_url: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const mockWorkspace: Workspace = {
  id: "ws-1",
  name: "Test Workspace",
  slug: "test-ws",
  description: null,
  context: null,
  settings: {},
  repos: [],
  issue_prefix: "TES",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function createStorage(values: Record<string, string> = {}): StorageAdapter {
  return {
    getItem: vi.fn((key: string) => values[key] ?? null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
}

function renderInitializer(options: {
  storage: StorageAdapter;
  cookieAuth?: boolean;
  onLogin?: () => void;
  onLogout?: () => void;
}) {
  return render(
    <AuthInitializer {...options}>
      <div>ready</div>
    </AuthInitializer>,
  );
}

beforeEach(() => {
  mocks.getMe.mockResolvedValue(mockUser);
  mocks.listWorkspaces.mockResolvedValue([mockWorkspace]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AuthInitializer cookie auth mode", () => {
  it("restores the session from the HttpOnly cookie instead of logging out", async () => {
    const onLogin = vi.fn();
    const onLogout = vi.fn();
    const storage = createStorage({
      multica_workspace_id: mockWorkspace.id,
    });

    renderInitializer({ storage, cookieAuth: true, onLogin, onLogout });

    await waitFor(() =>
      expect(mocks.hydrateWorkspace).toHaveBeenCalledWith(
        [mockWorkspace],
        mockWorkspace.id,
      ),
    );

    expect(mocks.getMe).toHaveBeenCalledTimes(1);
    expect(mocks.listWorkspaces).toHaveBeenCalledTimes(1);
    expect(mocks.setAuthState).toHaveBeenCalledWith({
      user: mockUser,
      isLoading: false,
    });
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(onLogout).not.toHaveBeenCalled();
    // Cookie mode must not depend on a token in storage.
    expect(mocks.setToken).not.toHaveBeenCalled();
  });

  it("signs out when the cookie session is no longer valid", async () => {
    mocks.getMe.mockRejectedValue(new Error("401"));
    const onLogout = vi.fn();
    const storage = createStorage();

    renderInitializer({ storage, cookieAuth: true, onLogout });

    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
    expect(mocks.hydrateWorkspace).not.toHaveBeenCalled();
    expect(mocks.setAuthState).toHaveBeenCalledWith({
      user: null,
      isLoading: false,
    });
  });
});

describe("AuthInitializer token mode", () => {
  it("still authenticates with the stored token", async () => {
    const storage = createStorage({
      multica_token: "token-1",
      multica_workspace_id: mockWorkspace.id,
    });

    renderInitializer({ storage });

    await waitFor(() =>
      expect(mocks.hydrateWorkspace).toHaveBeenCalledWith(
        [mockWorkspace],
        mockWorkspace.id,
      ),
    );
    expect(mocks.setToken).toHaveBeenCalledWith("token-1");
  });
});
