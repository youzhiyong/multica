"use client";

import { CoreProvider } from "@multica/core/platform";
import { WebNavigationProvider } from "@/platform/navigation";
import {
  setLoggedInCookie,
  clearLoggedInCookie,
} from "@/features/auth/auth-cookie";
import { deriveWsUrl } from "@/config/runtime-urls";

export function WebProviders({ children }: { children: React.ReactNode }) {
  return (
    <CoreProvider
      apiBaseUrl={process.env.NEXT_PUBLIC_API_URL}
      wsUrl={deriveWsUrl()}
      cookieAuth
      onLogin={setLoggedInCookie}
      onLogout={clearLoggedInCookie}
    >
      <WebNavigationProvider>{children}</WebNavigationProvider>
    </CoreProvider>
  );
}
