import { MailProvider } from "./provider.interface";
import { GmailProvider } from "./gmail/gmail.provider";

const providers: Record<string, MailProvider> = {
  GMAIL: new GmailProvider(),
  // OUTLOOK: new OutlookProvider(),  // implement when Outlook support is added
};

export function getProvider(type: string): MailProvider {
  const provider = providers[type];
  if (!provider) throw new Error(`No MailProvider registered for type "${type}"`);
  return provider;
}
