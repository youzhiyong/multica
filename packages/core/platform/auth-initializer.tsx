"use client";

import { useEffect, type ReactNode } from "react";
import { getApi } from "../api";
import { useAuthStore } from "../auth";
import { useWorkspaceStore } from "../workspace";
import { createLogger } from "../logger";
import { defaultStorage } from "./storage";
import type { StorageAdapter } from "../types/storage";

const logger = createLogger("auth");

export function AuthInitializer({
  children,
  onLogin,
  onLogout,
  storage = defaultStorage,
  cookieAuth,
}: {
  children: ReactNode;
  onLogin?: () => void;
  onLogout?: () => void;
  storage?: StorageAdapter;
  cookieAuth?: boolean;
}) {
  useEffect(() => {
    const api = getApi();
    const wsId = storage.getItem("multica_workspace_id");

    if (cookieAuth) {
      // Cookie mode: the HttpOnly auth cookie is sent automatically by the
      // browser, so there is no token in storage. Ask the API whether the
      // session is still valid instead of assuming the user is signed out.
      Promise.all([api.getMe(), api.listWorkspaces()])
        .then(([user, wsList]) => {
          onLogin?.();
          useAuthStore.setState({ user, isLoading: false });
          useWorkspaceStore.getState().hydrateWorkspace(wsList, wsId);
        })
        .catch((err) => {
          logger.error("cookie auth init failed", err);
          onLogout?.();
          useAuthStore.setState({ user: null, isLoading: false });
        });
      return;
    }

    // Token mode: read from localStorage (Electron / legacy).
    const token = storage.getItem("multica_token");
    if (!token) {
      onLogout?.();
      useAuthStore.setState({ isLoading: false });
      return;
    }

    api.setToken(token);

    Promise.all([api.getMe(), api.listWorkspaces()])
      .then(([user, wsList]) => {
        onLogin?.();
        useAuthStore.setState({ user, isLoading: false });
        useWorkspaceStore.getState().hydrateWorkspace(wsList, wsId);
      })
      .catch((err) => {
        logger.error("auth init failed", err);
        api.setToken(null);
        api.setWorkspaceId(null);
        storage.removeItem("multica_token");
        storage.removeItem("multica_workspace_id");
        onLogout?.();
        useAuthStore.setState({ user: null, isLoading: false });
      });
  }, []);

  return <>{children}</>;
}
