/**
 * Sending mail.
 *
 * An interface with two implementations, chosen the same way object storage is:
 * by whether the credentials exist. A deploy without a Postmark token logs what
 * it would have sent rather than failing, so a laptop and a preview environment
 * both work with no account.
 *
 * **No `postmark` npm package.** Their API is one authenticated JSON POST, and
 * `fetch` is built in. A dependency here would buy retries and typed errors —
 * both of which the outbox already provides, better, because it retries across
 * process restarts rather than within one request.
 */

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Groups sends in Postmark's dashboard. `invite`, `document-receipt`, … */
  tag?: string;
  /**
   * Postmark deduplicates nothing. This is ours, echoed back on the webhook so
   * a delivery event can be traced to the outbox message that caused it.
   */
  metadata?: Record<string, string>;
}

export interface Mailer {
  readonly name: string;
  send(email: Email): Promise<void>;
}

export class MailerError extends Error {
  readonly status: number;
  /** Postmark's own code. 406 = inactive recipient, 300 = invalid address. */
  readonly postmarkCode: number | undefined;

  constructor(status: number, postmarkCode: number | undefined, message: string) {
    super(message);
    this.name = 'MailerError';
    this.status = status;
    this.postmarkCode = postmarkCode;
  }

  /**
   * Whether retrying could ever help.
   *
   * A bad address is not a transient failure, and letting the outbox retry it
   * eight times with growing backoff turns one permanent error into a day of
   * noise. Rate limits and 5xx are worth retrying; a rejected recipient is not.
   */
  get retryable(): boolean {
    if (this.status === 429 || this.status >= 500) return true;
    // 300 invalid email, 406 inactive recipient, 422 unprocessable.
    return ![300, 406].includes(this.postmarkCode ?? 0) && this.status < 400;
  }
}

export class PostmarkMailer implements Mailer {
  readonly name = 'postmark';
  readonly #token: string;
  readonly #from: string;
  readonly #stream: string;

  constructor(config: { token: string; from: string; messageStream?: string }) {
    this.#token = config.token;
    this.#from = config.from;
    // Postmark separates transactional from broadcast streams. Everything HaulQ
    // sends is transactional; putting it on a broadcast stream would attach an
    // unsubscribe footer to an invitation.
    this.#stream = config.messageStream ?? 'outbound';
  }

  async send(email: Email): Promise<void> {
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': this.#token,
      },
      body: JSON.stringify({
        From: this.#from,
        To: email.to,
        Subject: email.subject,
        TextBody: email.text,
        HtmlBody: email.html,
        MessageStream: this.#stream,
        ...(email.tag ? { Tag: email.tag } : {}),
        ...(email.metadata ? { Metadata: email.metadata } : {}),
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        ErrorCode?: number;
        Message?: string;
      };
      throw new MailerError(
        response.status,
        body.ErrorCode,
        `postmark ${response.status}${body.ErrorCode ? ` (${body.ErrorCode})` : ''}: ${
          body.Message ?? 'no message'
        }`,
      );
    }
  }
}

/**
 * Logs instead of sending.
 *
 * Used when no Postmark token is configured. It logs the whole body including
 * any link, which is what makes the invite flow walkable locally with no
 * account — and is also why it must never be selected in production. The
 * factory in `server.ts` warns when it is.
 */
export class LogMailer implements Mailer {
  readonly name = 'log';
  readonly #log: (o: unknown, msg: string) => void;

  constructor(log: (o: unknown, msg: string) => void) {
    this.#log = log;
  }

  async send(email: Email): Promise<void> {
    this.#log(
      { to: email.to, subject: email.subject, body: email.text },
      'email NOT sent — no mailer configured',
    );
  }
}
