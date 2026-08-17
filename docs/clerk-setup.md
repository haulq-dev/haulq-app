# Wiring up Clerk

The code is written and tested. This is the dashboard work, which cannot be done
from here.

Nothing below is urgent — `AUTH_PROVIDER` defaults to `dev`, and everything
keeps working on the header stub until you switch it.

---

## 1. Create the instance

Sign up at clerk.com with a `haulq.ai` address, not a personal one — build plan
section 11. `hello@haulq.ai` now forwards to the Gmail account, so verification
mail will arrive.

Create an application. Enable **Email + password** and, if you want it, Google
sign-in. Under **Sessions**, leave the default lifetime alone.

**Do not enable Organizations.** HaulQ owns tenancy — `orgs` and
`org_memberships` in Postgres are the source of truth for who belongs to what,
with roles, invite state and entitlements attached. Turning on Clerk's version
means two systems believing they own that, kept in step by a webhook, and the
first time they disagree a carrier is either locked out of their own account or
looking at someone else's loads. The reasoning is in
`packages/db/src/repositories/identity.ts`.

## 2. Keys

From **API Keys**, take the publishable key and the secret key.

```
AUTH_PROVIDER=clerk
CLERK_SECRET_KEY=sk_live_...        # or sk_test_ for the dev instance
CLERK_PUBLISHABLE_KEY=pk_live_...   # the web app needs this, not the API
```

These go in Doppler, not in a file. `AUTH_PROVIDER` is explicit rather than
inferred from whether a key happens to be set, so a typo'd variable name fails
the boot instead of quietly downgrading a deployment to header-trusting auth.

## 3. Webhook

**Webhooks → Add Endpoint.**

- URL: `https://api.haulq.ai/webhooks/clerk`
- Events: `user.created`, `user.updated`, `user.deleted`

Copy the signing secret (`whsec_...`) into Doppler as `CLERK_WEBHOOK_SECRET`.

Without that variable the endpoint returns 503 and accepts nothing. That is
deliberate: an endpoint that writes to the users table without verifying a
signature is an unauthenticated write reachable by anyone who learns the URL.

To test locally, run the API on a tunnel and point a Clerk **development**
endpoint at it. Or replay a delivery without Clerk at all — `signSvix()` in
`apps/api/src/auth/svix-signature.ts` produces a valid signature from the same
secret, which is what the tests use.

## 4. Front end

The web app needs `@clerk/clerk-react`, `<ClerkProvider>`, and a sign-in route.
It must send two things with every API call:

- the session token, as `Authorization: Bearer <token>` or Clerk's `__session`
  cookie — both are accepted
- `X-HaulQ-Org-Id`, naming which account the request is for

The second is not optional and is not derivable from the session, because a user
can belong to several carriers. `GET /v1/orgs` (to be built with member invites)
will list the ones they can act in; until then, the org id from `POST /v1/orgs`
is what a newly signed-up carrier uses.

## 5. Switching over

Set `AUTH_PROVIDER=clerk` and redeploy. If `CLERK_SECRET_KEY` is missing the API
refuses to boot rather than falling back.

`DevAuthenticator` cannot be constructed when `NODE_ENV=production`, so a
production deployment that forgets to set `AUTH_PROVIDER` fails at startup
instead of serving header-trusting auth to the internet.

---

## What is already handled

- **The webhook can arrive late.** Clerk redirects the browser the instant
  sign-up completes; the webhook is a separate call. A user is created on first
  authenticated request if it has not arrived yet, so there is no race on the
  most important request a new carrier makes.
- **Retries.** Clerk redelivers on any non-2xx. Handlers are idempotent, and
  unrecognised event types return 200 — a 404 would make Clerk retry forever and
  eventually disable the endpoint.
- **Replay.** Signatures older than five minutes are refused.
- **Email changes.** Matching is on the Clerk user id, never on email. Email is
  mutable in Clerk, and matching on it would let a change of address attach a
  session to a different HaulQ user. `users.email` is deliberately not unique
  for the same reason.
- **`user.deleted` does not delete.** `users` is referenced by
  `event_log.actor_user_id`, and an audit trail whose actors have been removed
  is not an audit trail. Removing access is a membership change. A genuine
  erasure request is a separate, deliberate operation that also has to decide
  what happens to the events.
- **Roles come from Postgres on every request**, not from a token claim, so
  revoking someone takes effect immediately rather than when their session
  happens to refresh.

## What is not covered by tests

Clerk's own RS256/JWKS verification — `verifyToken` from `@clerk/backend`. It
needs a real instance, which is why it is injected as a constructor parameter
rather than imported directly: everything around it is tested against a fake.

The first real sign-in is therefore the first exercise of that one call. If it
fails, the error will say so plainly — `ClerkAuthenticator` wraps it as "Your
session has expired or is not valid."
