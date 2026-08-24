// Sends the scripted test emails to the support desk inbox.
//
//   node send.mjs list                 what scenarios exist
//   node send.mjs new-internal         send one
//   node send.mjs all                  send every scenario, 45s apart
//   node send.mjs all --delay 20       ...at a different spacing
//   node send.mjs change --ref T-10308 quote a booking that really exists
//
// The spacing matters: the desk polls Gmail on a timer, and sending nine
// emails in one burst makes it harder to tell which ticket came from which
// scenario. It also keeps Gmail from treating the run as a spam burst.
//
// Credentials come from .env (gitignored) and are never printed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scenarios, findScenario } from "./scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** A deliberately small .env reader — no dependency, no surprises. */
function loadEnv() {
  const file = path.join(here, ".env");
  if (!fs.existsSync(file)) {
    console.error(
      "No .env file here yet. Copy .env.example to .env and fill it in — see README.md."
    );
    process.exit(1);
  }
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  const missing = ["GMAIL_USER", "GMAIL_APP_PASSWORD", "TO_ADDRESS"].filter((k) => !env[k]);
  if (missing.length) {
    console.error(`.env is missing: ${missing.join(", ")}`);
    process.exit(1);
  }
  return env;
}

/**
 * A short tag appended to every subject line.
 *
 * Gmail threads by subject and participants, so sending the same scenario
 * twice landed the second one as a reply on the first ticket — no new ticket,
 * no new draft, and a re-test that silently tested nothing. A per-run tag
 * keeps each send a genuinely new conversation.
 */
function runTag() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  // Seconds included: two runs of the same scenario inside one minute would
  // otherwise share a tag, and thread onto each other exactly as before.
  return `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function printScenario(s, index, total) {
  console.log(`\n[${index}/${total}] ${s.id} — ${s.title}`);
  console.log(`    subject: ${s.subject}`);
  console.log("    what to check when it lands:");
  for (const line of s.check) console.log(`      · ${line}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [command = "list", ...rest] = process.argv.slice(2);

  if (command === "list") {
    console.log("Scenarios:\n");
    for (const s of scenarios) console.log(`  ${s.id.padEnd(18)} ${s.title}`);
    console.log(`\nSend one:  node send.mjs <id>\nSend all:  node send.mjs all\n`);
    return;
  }

  // Imported here rather than at the top so `list` works before npm install.
  const { default: nodemailer } = await import("nodemailer").catch(() => {
    console.error('nodemailer is not installed yet. Run "npm install" in this folder first.');
    process.exit(1);
  });

  const env = loadEnv();
  const delayIndex = rest.indexOf("--delay");
  const delaySeconds = delayIndex === -1 ? 45 : Number(rest[delayIndex + 1]) || 45;

  // A reference to quote, for the scenarios that can name a real booking.
  // Left off, they send their standalone wording exactly as before.
  const refIndex = rest.indexOf("--ref");
  const ref = refIndex === -1 ? null : rest[refIndex + 1];
  if (refIndex !== -1 && !ref) {
    console.error("--ref needs a booking reference, e.g. --ref T-10308");
    process.exit(1);
  }

  const withRef = (s) => {
    if (!ref) return s;
    if (typeof s.withRef !== "function") return s;
    return { ...s, ...s.withRef(ref) };
  };

  const chosen = (command === "all" ? scenarios : [findScenario(command)].filter(Boolean)).map(
    withRef
  );
  if (!chosen.length) {
    console.error(`Unknown scenario "${command}". Run: node send.mjs list`);
    process.exit(1);
  }

  const transport = nodemailer.createTransport({
    service: "gmail",
    auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
  });

  // Fail loudly on a bad app password before sending anything.
  try {
    await transport.verify();
  } catch (err) {
    console.error(
      "Gmail rejected the credentials. Check GMAIL_APP_PASSWORD is a 16-character app password " +
        "(not your Gmail password) and that 2-Step Verification is on for the account.\n" +
        `Gmail said: ${err.message}`
    );
    process.exit(1);
  }

  // --no-tag sends the subject exactly as written, for testing threading itself.
  const tag = rest.includes("--no-tag") ? null : runTag();
  console.log(
    `Sending ${chosen.length} email(s) from ${env.GMAIL_USER} to ${env.TO_ADDRESS}` +
      (tag ? ` (run tag ${tag}).` : ".")
  );

  for (const [i, s] of chosen.entries()) {
    const subject = tag ? `${s.subject} [${tag}]` : s.subject;
    printScenario({ ...s, subject }, i + 1, chosen.length);
    await transport.sendMail({
      from: env.GMAIL_USER,
      to: env.TO_ADDRESS,
      subject,
      text: s.body,
      headers: s.headers,
    });
    console.log("    sent.");
    if (i < chosen.length - 1) {
      console.log(`    waiting ${delaySeconds}s before the next one...`);
      await sleep(delaySeconds * 1000);
    }
  }

  console.log(
    `\nDone. Open the desk and give it a minute or two to poll: ` +
      `https://support-desk-production-90e4.up.railway.app/tickets`
  );
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
