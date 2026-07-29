import { google } from "googleapis";
import { env } from "../../config/env";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify", // read + label/archive
  "https://www.googleapis.com/auth/gmail.send", // send replies
];

export function createOAuthClient() {
  return new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
}

export function buildAuthUrl(state: string): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    // Force the consent screen every time so Google re-issues a refresh
    // token even if this browser previously authorized the app (Google
    // otherwise sometimes omits refresh_token on repeat consents).
    prompt: "consent",
    scope: GMAIL_SCOPES,
    state,
  });
}

export async function exchangeCodeForTokens(code: string) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Revoke this app's access at https://myaccount.google.com/permissions and try connecting again."
    );
  }
  client.setCredentials(tokens);
  return { client, tokens };
}

export function clientWithRefreshToken(refreshToken: string) {
  const client = createOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}
