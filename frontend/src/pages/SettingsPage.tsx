import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { EmailAccountStatus, PublicUser } from "../api/types";
import { useAuth } from "../hooks/useAuth";
import { Avatar } from "../components/Avatar";

function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-5 py-3.5">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

interface PollSummary {
  newMessages: number;
  failedAccounts: number;
  skipped: boolean;
}

function ConnectedMailboxes() {
  const [accounts, setAccounts] = useState<EmailAccountStatus[]>([]);
  const [gmailConfigured, setGmailConfigured] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [params] = useSearchParams();
  const { user } = useAuth();

  function load() {
    api
      .get<{ accounts: EmailAccountStatus[]; gmailConfigured: boolean }>("/email-accounts")
      .then((r) => {
        setAccounts(r.accounts);
        setGmailConfigured(r.gmailConfigured);
      });
  }

  useEffect(load, []);

  async function connectGmail() {
    const { authUrl } = await api.get<{ authUrl: string }>("/email-accounts/gmail/connect");
    window.location.href = authUrl;
  }

  // The mailbox is checked automatically on a timer; this is for when you
  // don't want to wait for the next round.
  async function checkNow() {
    setChecking(true);
    setCheckResult(null);
    try {
      const r = await api.post<PollSummary>("/email-accounts/poll-now");
      if (r.skipped) {
        setCheckResult("A check was already running — give it a few seconds.");
      } else if (r.failedAccounts > 0) {
        setCheckResult("Couldn't reach the mailbox. See its status above.");
      } else if (r.newMessages === 0) {
        setCheckResult("No new email.");
      } else {
        setCheckResult(`Found ${r.newMessages} new email${r.newMessages === 1 ? "" : "s"}.`);
      }
      load();
    } catch (err) {
      setCheckResult(err instanceof ApiError ? err.message : "Couldn't check for new mail.");
    } finally {
      setChecking(false);
    }
  }

  async function disconnect(id: string) {
    if (!confirm("Disconnect this mailbox? Incoming mail will stop syncing until it's reconnected.")) return;
    await api.delete(`/email-accounts/${id}`);
    load();
  }

  const status = params.get("status");

  return (
    <SectionCard title="Connected mailboxes" subtitle="Emails sent to a connected mailbox automatically become tickets.">
      {status === "success" && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-800">
          Connected {params.get("email")}. New mail will start appearing shortly.
        </div>
      )}
      {status === "error" && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800">
          Couldn't connect: {params.get("message")}
        </div>
      )}

      <div className="mb-4 space-y-2.5">
        {accounts.length === 0 && <p className="text-sm text-gray-500">No mailbox connected yet.</p>}
        {accounts.map((a) => (
          <div key={a.id} className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-red-50">
                <svg className="h-4.5 w-4.5" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ea4335" strokeWidth="2">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                </svg>
              </span>
              <div>
                <p className="text-sm font-medium text-gray-900">{a.email}</p>
                <p className="text-xs text-gray-500">
                  {a.provider === "GMAIL" ? "Gmail" : "Outlook"} ·{" "}
                  {a.status === "connected" ? (
                    <span className="font-medium text-emerald-600">Connected</span>
                  ) : (
                    <span className="font-medium text-red-600">{a.lastError ?? "Disconnected"}</span>
                  )}
                </p>
              </div>
            </div>
            {user?.role === "ADMIN" && (
              <button
                onClick={() => void disconnect(a.id)}
                className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50"
              >
                Disconnect
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        {user?.role === "ADMIN" ? (
          gmailConfigured ? (
            <button
              onClick={() => void connectGmail()}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700"
            >
              Connect Gmail
            </button>
          ) : (
            <p className="rounded-lg bg-gray-50 px-3.5 py-2.5 text-sm text-gray-600">
              Gmail isn't configured on the server yet — the GOOGLE_* environment variables need to be set.
            </p>
          )
        ) : (
          <p className="text-sm text-gray-500">Ask an admin to connect a mailbox.</p>
        )}

        {accounts.length > 0 && (
          <button
            onClick={() => void checkNow()}
            disabled={checking}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {checking ? "Checking…" : "Check for new email"}
          </button>
        )}

        {checkResult && <span className="text-sm text-gray-500">{checkResult}</span>}
      </div>

      {accounts.length > 0 && (
        <p className="mt-3 text-xs text-gray-400">
          New mail is picked up automatically every 30 seconds; use this if you don't want to wait.
        </p>
      )}
    </SectionCard>
  );
}

function TeamMembers() {
  const { user } = useAuth();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"ADMIN" | "AGENT">("AGENT");
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.get<{ users: PublicUser[] }>("/users").then((r) => setUsers(r.users));
  }

  useEffect(load, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/users", { name, email, password, role });
      setName("");
      setEmail("");
      setPassword("");
      setRole("AGENT");
      setShowForm(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add team member.");
    }
  }

  const inputClass =
    "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";

  return (
    <SectionCard title="Team members" subtitle="Anyone here can be assigned tickets.">
      <ul className="mb-4 divide-y divide-gray-100">
        {users.map((u) => (
          <li key={u.id} className="flex items-center gap-3 py-2.5">
            <Avatar name={u.name} size={8} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-gray-900">{u.name}</p>
              <p className="truncate text-xs text-gray-500">{u.email}</p>
            </div>
            <span
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                u.role === "ADMIN" ? "bg-indigo-50 text-indigo-700" : "bg-gray-100 text-gray-500"
              }`}
            >
              {u.role}
            </span>
          </li>
        ))}
      </ul>

      {user?.role === "ADMIN" &&
        (showForm ? (
          <form onSubmit={handleAdd} className="space-y-3 rounded-lg border border-gray-200 bg-gray-50/60 p-4">
            <input placeholder="Name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
            <input
              type="email"
              placeholder="Email"
              className={inputClass}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              type="password"
              placeholder="Temporary password (min 8 chars)"
              minLength={8}
              className={inputClass}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value as "ADMIN" | "AGENT")}>
              <option value="AGENT">Agent</option>
              <option value="ADMIN">Admin</option>
            </select>
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                className="rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700"
              >
                Add member
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-lg px-3 py-2 text-sm text-gray-500 hover:bg-gray-100"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setShowForm(true)}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700"
          >
            Add team member
          </button>
        ))}
    </SectionCard>
  );
}

export function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Settings</h1>
        <p className="mt-0.5 text-sm text-gray-500">Mailboxes and team access.</p>
      </div>
      <ConnectedMailboxes />
      <TeamMembers />
    </div>
  );
}
