import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { EmailAccountStatus, PublicUser } from "../api/types";
import { useAuth } from "../hooks/useAuth";

function ConnectedMailboxes() {
  const [accounts, setAccounts] = useState<EmailAccountStatus[]>([]);
  const [gmailConfigured, setGmailConfigured] = useState(true);
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

  async function disconnect(id: string) {
    if (!confirm("Disconnect this mailbox? Incoming mail will stop syncing until it's reconnected.")) return;
    await api.delete(`/email-accounts/${id}`);
    load();
  }

  const status = params.get("status");

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="mb-1 text-base font-semibold text-gray-900">Connected mailboxes</h2>
      <p className="mb-4 text-sm text-gray-500">
        Emails sent to a connected mailbox automatically become tickets.
      </p>

      {status === "success" && (
        <div className="mb-3 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
          Connected {params.get("email")}. New mail will start appearing shortly.
        </div>
      )}
      {status === "error" && (
        <div className="mb-3 rounded-md bg-red-50 p-3 text-sm text-red-800">
          Couldn't connect: {params.get("message")}
        </div>
      )}

      <div className="mb-4 space-y-2">
        {accounts.length === 0 && <p className="text-sm text-gray-500">No mailbox connected yet.</p>}
        {accounts.map((a) => (
          <div key={a.id} className="flex items-center justify-between rounded-md border border-gray-200 p-3">
            <div>
              <p className="text-sm font-medium text-gray-900">{a.email}</p>
              <p className="text-xs text-gray-500">
                {a.provider} ·{" "}
                {a.status === "connected" ? (
                  <span className="text-emerald-600">Connected</span>
                ) : (
                  <span className="text-red-600">{a.lastError ?? "Disconnected"} — reconnect below</span>
                )}
              </p>
            </div>
            {user?.role === "ADMIN" && (
              <button
                onClick={() => void disconnect(a.id)}
                className="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50"
              >
                Disconnect
              </button>
            )}
          </div>
        ))}
      </div>

      {user?.role === "ADMIN" ? (
        gmailConfigured ? (
          <button
            onClick={() => void connectGmail()}
            className="rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            Connect Gmail
          </button>
        ) : (
          <p className="rounded-md bg-gray-50 p-3 text-sm text-gray-600">
            Gmail isn't configured on the server yet. See <code>docs/GOOGLE_OAUTH_SETUP.md</code> for the setup
            steps, then set the <code>GOOGLE_CLIENT_ID</code>/<code>GOOGLE_CLIENT_SECRET</code> environment
            variables and restart the app.
          </p>
        )
      ) : (
        <p className="text-sm text-gray-500">Ask an admin to connect a mailbox.</p>
      )}
    </section>
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

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="mb-1 text-base font-semibold text-gray-900">Team members</h2>
      <p className="mb-4 text-sm text-gray-500">Anyone here can be assigned tickets.</p>

      <ul className="mb-4 divide-y divide-gray-100">
        {users.map((u) => (
          <li key={u.id} className="flex items-center justify-between py-2 text-sm">
            <span>
              {u.name} <span className="text-gray-400">· {u.email}</span>
            </span>
            <span className="text-xs uppercase text-gray-400">{u.role}</span>
          </li>
        ))}
      </ul>

      {user?.role === "ADMIN" &&
        (showForm ? (
          <form onSubmit={handleAdd} className="space-y-2 rounded-md border border-gray-200 p-3">
            <input
              placeholder="Name"
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <input
              type="email"
              placeholder="Email"
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              type="password"
              placeholder="Temporary password (min 8 chars)"
              minLength={8}
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <select
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value as "ADMIN" | "AGENT")}
            >
              <option value="AGENT">Agent</option>
              <option value="ADMIN">Admin</option>
            </select>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800"
              >
                Add
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="text-sm text-gray-500">
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setShowForm(true)}
            className="rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            Add team member
          </button>
        ))}
    </section>
  );
}

export function SettingsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
      <ConnectedMailboxes />
      <TeamMembers />
    </div>
  );
}
