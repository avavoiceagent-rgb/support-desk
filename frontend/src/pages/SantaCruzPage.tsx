// The page that connects SantaCruz to Adam.
//
// Three things, in the order somebody actually does them: say where SantaCruz
// is and how it writes its dates; say which of their columns is which of ours;
// then try it against a real export and read exactly what came in and what did
// not.
//
// Two rules this screen is built around:
//
// 1. **No secret is ever shown here.** The API keys live in Railway's
//    environment variables. This page says whether one is set. It cannot say
//    what it is, and there is deliberately nowhere to type one.
// 2. **Nothing is guessed.** A row that cannot be read is refused and listed
//    with the reason, rather than imported with a zero or a default in the gap.

import { useCallback, useEffect, useState } from "react";
import {
  santacruzApi,
  parseCsv,
  type FieldMapping,
  type ImportOutcome,
  type ImportRun,
  type Rejection,
  type SantaCruzConnection,
  type TargetField,
} from "../api/santacruz";
import { useAuth } from "../hooks/useAuth";
import { Button, Card, Empty, ErrorNote, Field, apiMessage, inputClass, when } from "../components/ops/shared";

const ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
];

function Yes({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm ${on ? "text-emerald-700" : "text-gray-500"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-emerald-500" : "bg-gray-300"}`} />
      {children}
    </span>
  );
}

export function SantaCruzPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const [connection, setConnection] = useState<SantaCruzConnection | null>(null);
  const [fields, setFields] = useState<TargetField[]>([]);
  const [mapping, setMapping] = useState<FieldMapping[]>([]);
  const [imports, setImports] = useState<ImportRun[]>([]);
  const [rejections, setRejections] = useState<Rejection[]>([]);
  const [openRun, setOpenRun] = useState<string | null>(null);

  const [pasted, setPasted] = useState("");
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [parseProblems, setParseProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [c, f, m, i] = await Promise.all([
        santacruzApi.connection(),
        santacruzApi.fields(),
        santacruzApi.mapping(),
        santacruzApi.imports(),
      ]);
      setConnection(c);
      setFields(f);
      setMapping(m);
      setImports(i);
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const columnFor = (target: string) =>
    mapping.find((m) => m.targetField === target)?.sourceColumn ?? "";

  function setColumn(target: string, column: string) {
    setMapping((prev) => {
      const rest = prev.filter((m) => m.targetField !== target);
      return column.trim() === "" ? rest : [...rest, { targetField: target, sourceColumn: column }];
    });
  }

  async function saveMapping() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      setMapping(await santacruzApi.saveMapping(mapping));
      setConnection(await santacruzApi.connection());
      setSaved("Mapping saved.");
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveConnection(patch: Parameters<typeof santacruzApi.saveConnection>[0]) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      setConnection(await santacruzApi.saveConnection(patch));
      setSaved("Connection saved.");
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function importPasted() {
    setBusy(true);
    setError(null);
    setOutcome(null);
    setRejections([]);
    try {
      const text = pasted.trim();
      const rows = text.startsWith("[")
        ? (JSON.parse(text) as Record<string, unknown>[])
        : (() => {
            const parsed = parseCsv(text);
            setParseProblems(parsed.problems);
            return parsed.rows;
          })();
      if (rows.length === 0) throw new Error("There were no rows to import.");
      const result = await santacruzApi.runImport(rows, "Pasted export");
      setOutcome(result);
      setImports(await santacruzApi.imports());
      setConnection(await santacruzApi.connection());
      if (result.rowsRejected > 0) {
        setRejections(await santacruzApi.rejections(result.importId));
        setOpenRun(result.importId);
      }
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function showRejections(runId: string) {
    if (openRun === runId) {
      setOpenRun(null);
      return;
    }
    setOpenRun(runId);
    setRejections(await santacruzApi.rejections(runId));
  }

  if (loading) return <p className="py-12 text-center text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-gray-900">SantaCruz</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          SantaCruz owns the booking; Adam owns the conversation. Their reservations are copied in
          and shown beside the emails they arrived through. Nothing is ever written back to them.
        </p>
      </div>

      <ErrorNote message={error} />
      {saved && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {saved}
        </p>
      )}

      <Card title="Connection">
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Yes on={connection?.outboundKeySet ?? false}>
              {connection?.outboundKeySet
                ? "A key for calling SantaCruz is set in Railway"
                : "No SANTACRUZ_API_KEY set in Railway"}
            </Yes>
            <Yes on={connection?.inboundKeySet ?? false}>
              {connection?.inboundKeySet
                ? "A key for SantaCruz to call us is set"
                : "No SANTACRUZ_INBOUND_KEY set in Railway"}
            </Yes>
            <Yes on={connection?.readyForFileImport ?? false}>
              {connection?.readyForFileImport
                ? "Mapping is complete enough to import"
                : "Mapping is not finished"}
            </Yes>
          </div>

          <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
            Keys are set in Railway's Variables tab and nowhere else. This page can tell you whether
            one exists; it cannot show you the value, and there is no box here to type one into.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Where SantaCruz lives"
              hint="Their API address, once GroundWidgets have given you one. Blank is fine — a file import needs no address."
            >
              <input
                className={inputClass}
                defaultValue={connection?.baseUrl ?? ""}
                placeholder="https://…"
                disabled={!isAdmin || busy}
                onBlur={(e) =>
                  void saveConnection({ baseUrl: e.target.value.trim() === "" ? null : e.target.value.trim() })
                }
              />
            </Field>

            <Field
              label="The time zone their dates are written in"
              hint="A reservation system usually sends wall-clock time with no zone on it. Getting this wrong moves every pickup by hours, so it is chosen rather than assumed."
            >
              <select
                className={inputClass}
                value={connection?.sourceTimeZone ?? "America/New_York"}
                disabled={!isAdmin || busy}
                onChange={(e) => void saveConnection({ sourceTimeZone: e.target.value })}
              >
                {ZONES.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div>
            <p className="text-xs font-medium text-gray-600">Where SantaCruz asks Adam what it knows</p>
            <code className="mt-1 block break-all rounded-lg bg-gray-900 px-3 py-2 text-xs text-gray-100">
              GET {connection?.inboundUrl}
            </code>
            <p className="mt-1 text-[11px] text-gray-400">
              They send the shared secret as an <code>x-api-key</code> header. Read only — it returns
              what Adam knows about the conversation, never a copy of their own booking data, so the
              two can never disagree.
            </p>
          </div>
        </div>
      </Card>

      <Card
        title="Which of their columns is which of ours"
        action={
          isAdmin ? (
            <Button kind="primary" onClick={() => void saveMapping()} disabled={busy}>
              Save mapping
            </Button>
          ) : undefined
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-100 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-5 py-2 font-medium">Adam needs</th>
                <th className="px-5 py-2 font-medium">SantaCruz calls it</th>
                <th className="px-5 py-2 font-medium">What it is</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {fields.map((f) => (
                <tr key={f.name} className={f.required ? "bg-amber-50/30" : undefined}>
                  <td className="whitespace-nowrap px-5 py-2 font-medium text-gray-800">
                    {f.name}
                    {f.required && <span className="ml-1 text-xs font-normal text-amber-700">required</span>}
                  </td>
                  <td className="px-5 py-2">
                    <input
                      className={`${inputClass} font-mono text-xs`}
                      defaultValue={columnFor(f.name)}
                      placeholder="their column name"
                      disabled={!isAdmin}
                      onChange={(e) => setColumn(f.name, e.target.value)}
                    />
                  </td>
                  <td className="px-5 py-2 text-xs text-gray-500">{f.describe}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Try it against a real export">
        <div className="space-y-3 px-5 py-4">
          <p className="text-xs text-gray-500">
            Paste a CSV export from SantaCruz, or a JSON array of rows. Nothing is uploaded or stored
            on the way in. Run it as many times as you like — a booking is matched on their own id,
            so re-importing the same file corrects what came in rather than duplicating it.
          </p>
          <textarea
            className={`${inputClass} h-40 font-mono text-xs`}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={"RES_ID,PU_DATETIME,PU_ADDR,PAX_NAME\nSC-1,2026-10-01 09:00,\"245 Park Ave, New York, NY\",Ana Costa"}
            disabled={!isAdmin}
          />
          <div className="flex items-center gap-3">
            <Button
              kind="primary"
              onClick={() => void importPasted()}
              disabled={!isAdmin || busy || pasted.trim() === ""}
            >
              {busy ? "Importing…" : "Import"}
            </Button>
            {!connection?.readyForFileImport && (
              <span className="text-xs text-amber-700">
                Finish the mapping first — {connection?.missingRequired.join(", ")} still has nothing
                pointing at it.
              </span>
            )}
          </div>

          {parseProblems.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {parseProblems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}

          {outcome && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
              <p>
                <strong>{outcome.rowsImported}</strong> of {outcome.rowsSeen} rows came in
                {outcome.rowsRejected > 0 && (
                  <>
                    , <strong className="text-red-700">{outcome.rowsRejected}</strong> were refused
                  </>
                )}
                .
              </p>
              {outcome.unmappedColumns.length > 0 && (
                <p className="mt-1 text-xs text-gray-500">
                  Columns in their file that nothing is mapped to, kept but unused:{" "}
                  <span className="font-mono">{outcome.unmappedColumns.join(", ")}</span>
                </p>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card title="Imports">
        {imports.length === 0 ? (
          <Empty>Nothing has been imported yet.</Empty>
        ) : (
          <ul className="divide-y divide-gray-100">
            {imports.map((run) => (
              <li key={run.id} className="px-5 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm text-gray-800">
                    {run.label ?? run.source} · {run.rowsImported} in
                    {run.rowsRejected > 0 && (
                      <button
                        onClick={() => void showRejections(run.id)}
                        className="ml-1 font-medium text-red-700 underline"
                      >
                        {run.rowsRejected} refused
                      </button>
                    )}
                  </p>
                  <span className="text-xs text-gray-400">
                    {when(run.startedAt)} {run.actorName ? `· ${run.actorName}` : ""}
                  </span>
                </div>

                {openRun === run.id && rejections.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {rejections.map((r) => (
                      <li key={r.id} className="rounded-lg border border-red-100 bg-red-50 px-3 py-2">
                        <p className="text-xs font-medium text-red-900">
                          Row {r.rowNumber}
                          {r.externalId ? ` · ${r.externalId}` : ""}
                        </p>
                        <ul className="mt-1 list-disc pl-4 text-xs text-red-800">
                          {r.reasons.map((reason, i) => (
                            <li key={i}>{reason}</li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
