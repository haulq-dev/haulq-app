/**
 * Handing a connect flow back to the mobile app (MOBILE_PARITY_PLAN.md M6).
 *
 * Motive's OAuth and Unipile's hosted auth both finish with a browser
 * redirect. On the web that lands on a web page. In the app it happens inside
 * the in-app browser (SFSafariViewController / a Custom Tab), where a web
 * page would ask the person to sign in all over again. So a connect started
 * from the app ends here instead, and this page hands off to the app's own
 * URL scheme, `ai.haulq.app://integrations?...`, which closes the browser
 * and shows the result (`appUrlOpen` in `apps/mobile/src/main.tsx`).
 *
 * Why a page and not a 302 straight to the scheme: Unipile may only accept
 * an https redirect, and a browser that won't follow an automatic hop to a
 * custom scheme still needs something to tap. The meta refresh makes the
 * hop; the button is for when it doesn't.
 *
 * Public, like the callbacks that send people here. It only ever builds one
 * fixed scheme and host from enum-checked values, so it can't be turned into
 * an open redirect or an injection.
 */

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

export const APP_SCHEME = 'ai.haulq.app';

const AppReturnQuerySchema = z.object({
  motive: z.enum(['connected', 'denied', 'error', 'not_configured']).optional(),
  mailbox: z.enum(['connected', 'denied']).optional(),
});

export type AppReturnResult = z.infer<typeof AppReturnQuerySchema>;

/** The path on this API a flow started from the app should finish at. */
export function appReturnPath(result: AppReturnResult): string {
  const params = new URLSearchParams(Object.entries(result).filter(([, v]) => v !== undefined) as [string, string][]);
  return `/v1/app-return?${params}`;
}

export function appUrl(result: AppReturnResult): string {
  const params = new URLSearchParams(Object.entries(result).filter(([, v]) => v !== undefined) as [string, string][]);
  return `${APP_SCHEME}://integrations${params.size ? `?${params}` : ''}`;
}

const HEADLINE = (r: AppReturnResult): string =>
  r.motive === 'connected' || r.mailbox === 'connected'
    ? 'Connected.'
    : r.motive === 'denied' || r.mailbox === 'denied'
      ? 'Connection cancelled.'
      : 'That didn’t finish.';

export async function appReturnRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/app-return',
    {
      schema: {
        tags: ['Integrations'],
        summary: 'Hand a connect flow back to the mobile app',
        querystring: AppReturnQuerySchema,
      },
    },
    async (request, reply) => {
      const target = appUrl(request.query);
      // Every interpolated value is either a constant or a URL built only
      // from enum members above; nothing a caller typed reaches the markup.
      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=${target}">
<title>Back to HaulQ</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 4rem 1.5rem; text-align: center; color: #1c1c1e; background: #f2f2f7; }
  h1 { font-size: 1.375rem; margin: 0 0 .5rem; }
  p { color: #3c3c43; margin: 0 0 1.5rem; }
  a { display: inline-block; background: #ff6800; color: #fff; text-decoration: none; font-weight: 600; padding: .875rem 1.5rem; border-radius: 12px; }
</style>
</head>
<body>
<h1>${HEADLINE(request.query)}</h1>
<p>Heading back to the HaulQ app.</p>
<a href="${target}">Open HaulQ</a>
</body>
</html>`;
      return reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(html);
    },
  );
}
