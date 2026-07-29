import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "../api/client";
import type { PublicUser } from "../api/types";

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  needsSetup: boolean;
  login: (email: string, password: string) => Promise<void>;
  setup: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const setupStatus = await api.get<{ needsSetup: boolean }>("/auth/setup-status");
      setNeedsSetup(setupStatus.needsSetup);
      if (setupStatus.needsSetup) {
        setUser(null);
        return;
      }
      const { user } = await api.get<{ user: PublicUser }>("/auth/me");
      setUser(user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
      } else {
        console.error("Failed to load auth state", err);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const { user } = await api.post<{ user: PublicUser }>("/auth/login", { email, password });
    setUser(user);
    setNeedsSetup(false);
  }, []);

  const setup = useCallback(async (name: string, email: string, password: string) => {
    const { user } = await api.post<{ user: PublicUser }>("/auth/setup", { name, email, password });
    setUser(user);
    setNeedsSetup(false);
  }, []);

  const logout = useCallback(async () => {
    await api.post("/auth/logout");
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, needsSetup, login, setup, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
