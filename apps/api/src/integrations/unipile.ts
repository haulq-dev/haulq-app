/**
 * Unipile — hosted mailbox connection and attachment retrieval.
 *
 * `FEATURE_REQUESTS_PLAN.md` section 1: the mailbox-ingest half of "send AI
 * the ratecon" — connect the carrier's actual work inbox (Gmail/Outlook/
 * IMAP) so a rate confirmation reaches HaulQ's existing Docs pipeline the
 * moment a broker sends it, instead of waiting on a manual forward to
 * `docs+{slug}@docs.haulq.ai`. Chosen over building Gmail API + Microsoft
 * Graph OAuth natively: one unified API, one webhook shape, no per-provider
 * OAuth flow for HaulQ to own — see that section's research for the
 * comparison against Nylas and native.
 *
 * Written against Unipile's own published API
 * (developer.unipile.com/docs/hosted-auth, /docs/new-emails-webhook,
 * /reference/mailscontroller_getattachment), checked there directly on
 * 2026-09-16, not guessed — but this codebase has no Unipile account yet.
 * Same "validate before trusting" caveat `here.ts`'s own module note
 * carries for HERE: run this file's tests against a real hosted-auth
 * response and a real new-email webhook delivery the day an account
 * activates, before any of it reaches a carrier's inbox.
 *
 * Three calls: **send** (added for `FEATURE_REQUESTS_PLAN.md` section 8 —
 * only ever invoked through `outbound/dispatch.ts`, which enforces the
 * carrier's autonomy policy before anything leaves), **connect**, and
 * **fetch attachment**. Connect (this file) hands back a URL
 * a browser is redirected to — Unipile itself runs the actual Google/
 * Microsoft OAuth dialog, so HaulQ never touches a mailbox password or an
 * OAuth code exchange. **Fetch attachment** is the only other call this
 * integration makes — the new-email webhook (`unipile-inbound.ts`) carries
 * metadata only, not bytes, the same "webhook says what happened, a
 * follow-up call gets the payload" shape `motive-sync.ts` already uses for
 * vehicle positions.
 */

export class UnipileApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'UnipileApiError';
    this.status = status;
  }
}

export interface UnipileConfig {
  apiKey: string;
  /** The account's own DSN, e.g. `https://api8.unipile.com:13851` — not a shared HaulQ-wide URL, Unipile assigns one per account. */
  dsn: string;
}

export interface HostedAuthLinkInput {
  /** Carried back verbatim on the `notify_url` callback — HaulQ's own org id, so the two requests correlate with no state-signing of our own. */
  name: string;
  /** Server-to-server callback with `{status, account_id, name}` once the carrier finishes (or fails) the flow. */
  notifyUrl: string;
  /** Browser redirect targets — pure UI, carry no account information themselves. */
  successRedirectUrl: string;
  failureRedirectUrl: string;
  /** How long the link stays valid. Unipile's own guidance: minutes to a few hours, not longer. */
  expiresInMinutes?: number;
}

interface HostedAuthLinkResponse {
  object?: string;
  url?: string;
}

export interface SendEmailInput {
  accountId: string;
  to: string[];
  subject: string;
  /** Plain text. The client renders it to HTML, since Unipile's body is HTML by default. */
  body: string;
  /** A prior message's provider id — makes this a threaded reply. */
  replyToProviderId?: string | undefined;
  /**
   * Unipile's `Idempotency-Key`: a retry with the same key returns the
   * original result instead of sending twice. Callers pass the outbound
   * message's own id.
   */
  idempotencyKey: string;
  /** Files to attach. Sent as multipart, the format Unipile documents for attachments. */
  attachments?: Array<{ filename: string; contentType: string; body: Buffer }> | undefined;
}

interface SendEmailResponse {
  provider_id?: string;
  tracking_id?: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Plain text to HTML that keeps its line breaks — escaped, so a body can never inject markup. */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>\n');
}

export interface UnipileClient {
  /**
   * Send an email from a connected mailbox. Sends nothing HaulQ has not
   * already decided to send — the caller is `outbound/dispatch.ts`, the one
   * choke point, and nothing else should call this directly.
   */
  sendEmail(input: SendEmailInput): Promise<{ providerMessageId: string | null }>;
  /** Returns the URL to redirect the carrier's browser to — does not redirect itself, same "hand back the URL" shape `motiveAuthorizeUrl` uses. */
  createHostedAuthLink(input: HostedAuthLinkInput): Promise<string>;
  /** Raw bytes and the provider-claimed content type for one attachment on one email. */
  fetchAttachment(emailId: string, accountId: string, attachmentId: string): Promise<{ body: Buffer; contentType: string | null }>;
}

const DEFAULT_EXPIRES_IN_MINUTES = 30;

export class UnipileHostedClient implements UnipileClient {
  private readonly apiKey: string;
  private readonly dsn: string;

  constructor(config: UnipileConfig) {
    this.apiKey = config.apiKey;
    this.dsn = config.dsn.replace(/\/$/, '');
  }

  async createHostedAuthLink(input: HostedAuthLinkInput): Promise<string> {
    const expiresOn = new Date(
      Date.now() + (input.expiresInMinutes ?? DEFAULT_EXPIRES_IN_MINUTES) * 60_000,
    ).toISOString();

    let response: Response;
    try {
      response = await fetch(`${this.dsn}/api/v1/hosted/accounts/link`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'create',
          // Every provider whose OAuth flow already exists elsewhere in this
          // codebase for something else (LinkedIn, WhatsApp) stays off this
          // list on purpose — a carrier connecting a mailbox should see
          // Google, Microsoft and IMAP, not a wizard offering four things
          // this feature does nothing with.
          providers: ['GOOGLE', 'OUTLOOK', 'MAIL'],
          api_url: this.dsn,
          expiresOn,
          notify_url: input.notifyUrl,
          success_redirect_url: input.successRedirectUrl,
          failure_redirect_url: input.failureRedirectUrl,
          name: input.name,
        }),
      });
    } catch (err) {
      throw new UnipileApiError(0, `Unipile unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new UnipileApiError(response.status, `Unipile ${response.status}: ${text.slice(0, 500)}`);
    }

    const body = (await response.json()) as HostedAuthLinkResponse;
    if (!body.url) {
      throw new UnipileApiError(0, 'Unipile returned no hosted auth URL');
    }
    return body.url;
  }

  async sendEmail(input: SendEmailInput): Promise<{ providerMessageId: string | null }> {
    const fields = {
      account_id: input.accountId,
      to: input.to.map((identifier) => ({ identifier })),
      subject: input.subject,
      body: textToHtml(input.body),
      ...(input.replyToProviderId ? { reply_to: input.replyToProviderId } : {}),
    };

    let headers: Record<string, string>;
    let payload: string | FormData;
    if (input.attachments && input.attachments.length > 0) {
      // Multipart, per Unipile's "Send attachments" example: scalar fields as
      // form fields (`to` as a JSON string), each file as an `attachments`
      // part. The boundary header is set by `fetch` from the FormData — a
      // hand-set content-type here would drop it and break the request.
      const form = new FormData();
      form.append('account_id', fields.account_id);
      form.append('subject', fields.subject);
      form.append('body', fields.body);
      form.append('to', JSON.stringify(fields.to));
      if (input.replyToProviderId) form.append('reply_to', input.replyToProviderId);
      for (const file of input.attachments) {
        form.append('attachments', new Blob([new Uint8Array(file.body)], { type: file.contentType }), file.filename);
      }
      payload = form;
      headers = {
        'x-api-key': this.apiKey,
        accept: 'application/json',
        'idempotency-key': input.idempotencyKey,
      };
    } else {
      payload = JSON.stringify(fields);
      headers = {
        'x-api-key': this.apiKey,
        accept: 'application/json',
        'content-type': 'application/json',
        'idempotency-key': input.idempotencyKey,
      };
    }

    let response: Response;
    try {
      response = await fetch(`${this.dsn}/api/v1/emails`, { method: 'POST', headers, body: payload });
    } catch (err) {
      throw new UnipileApiError(0, `Unipile unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new UnipileApiError(response.status, `Unipile ${response.status}: ${text.slice(0, 500)}`);
    }

    // The response shape is not confirmed against a real send — same
    // caveat as the rest of this file. Read defensively: a sent message
    // with no id we recognize is still a sent message.
    const body = (await response.json().catch(() => ({}))) as SendEmailResponse;
    return { providerMessageId: body.provider_id ?? body.tracking_id ?? null };
  }

  async fetchAttachment(
    emailId: string,
    accountId: string,
    attachmentId: string,
  ): Promise<{ body: Buffer; contentType: string | null }> {
    const url = new URL(`${this.dsn}/api/v1/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`);
    url.searchParams.set('account_id', accountId);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { 'x-api-key': this.apiKey },
      });
    } catch (err) {
      throw new UnipileApiError(0, `Unipile unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new UnipileApiError(response.status, `Unipile ${response.status}: ${text.slice(0, 500)}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return { body: buffer, contentType: response.headers.get('content-type') };
  }
}
