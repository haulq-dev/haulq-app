# Deploying to Render, with Doppler

`render.yaml` at the repo root defines everything. This is the order to do it in
and the things that will bite.

---

## 0. Before anything: the repo

`haulq-app` is **not a git repository yet**, and the GitHub repo already named
`haulq-app` under `haulq-dev` is the *dispatcher's* remote:

```
ai-load-dispatcher  →  github.com/haulq-dev/haulq-app.git
haulq-site          →  github.com/haulq-dev/haulq-site.git
haulq-app           →  no repo
```

That name collision has to be resolved before Render can pull anything. Two
sane options:

- **Rename the dispatcher's remote** to `haulq-dispatcher` (GitHub redirects the
  old URL, so nothing breaks) and create `haulq-app` fresh for this code. The
  names then say what the things are.
- **Push this as `haulq-platform`** and leave the dispatcher where it is.

Either way, `git init && git add . && git commit` in `haulq-app`, push, and
point Render at that repo. Check the first commit does not include an `.env` —
`.gitignore` covers it, but section 15 of the build plan exists because an SSH
keypair once reached a repo this way.

---

## 1. Postgres

Create it first — the API's `DATABASE_URL` references it.

The Blueprint creates it as **free**, which is right for a demo and wrong for
anything else: a free Postgres instance **expires after 30 days**, with a
further 14 days before the data is deleted. If a real carrier's imported history
is going in, change `plan: free` to a paid plan before you load it, not after.

`DATABASE_URL` comes from `fromDatabase` and is the **internal** connection
string — same region, private network, never exposed. `ipAllowList: []` means
nothing outside Render can connect at all, which is what you want and also means
you cannot connect from your laptop without temporarily opening it.

## 2. Doppler

Use the **Render integration**, not a service token. The integration pushes
secrets into Render's environment continuously; a service token would mean
wrapping the start command in `doppler run` and giving the container network
access to Doppler at boot, which is one more thing that can be down when you
deploy.

1. Render → Account Settings → API Keys → create one.
2. Doppler → your project → Integrations → Render → paste the API key.
3. Choose the config (`prd`) and the Render service (`haulq-api`).

**Do not put `DATABASE_URL` in Doppler.** Render sets it from the database, and
the Doppler sync would overwrite it. The symptom is an API that talks to the
wrong database — or nothing — after an unrelated secret changes, which is a
miserable thing to diagnose.

What belongs in Doppler:

```
CLERK_SECRET_KEY          sk_live_...
CLERK_WEBHOOK_SECRET      whsec_...
R2_ACCOUNT_ID             once storage moves off disk
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

Those are marked `sync: false` in `render.yaml`, which tells Render "this value
is managed elsewhere, do not clear it."

## 3. Apply the Blueprint

Render Dashboard → Blueprints → New Blueprint Instance → pick the repo.

Both services use `rootDir: .` even though neither lives at the root. That is
correct for a pnpm workspace: the lockfile and `packages/*` are at the root, and
pnpm needs to see all of them. Scoping happens with `--filter` in the build
command instead.

`buildFilter` on each service stops a CSS change from redeploying the API.

## 4. Migrations

`preDeployCommand` runs them after the build and before the new version takes
traffic, so a deploy that cannot migrate never serves. **It requires a paid
instance type.**

On a free instance, run them yourself against the external connection string
(temporarily allow your IP in the database's access control):

```bash
DATABASE_URL='<external connection string>' pnpm --filter @haulq/db migrate
```

The migration is idempotent — `sql/pre` and `sql/post` re-run on every deploy by
design — so running it twice is safe. CI proves that on every commit.

## 5. Custom domains

- `haulq-api` → `api.haulq.ai`
- `haulq-web` → `app.haulq.ai`

Both are CNAMEs to the `onrender.com` host. `haulq.ai` itself stays pointed at
the Cloudflare Worker — **do not touch its apex record.** Build plan section 14
is explicit that the marketing site must not be disturbed before the Worker
cutover is verified.

Set the Cloudflare records to **DNS-only (grey cloud)** while Render issues
certificates. Proxying breaks the ACME challenge, and the failure reads as "Render
can't verify the domain" with no mention of Cloudflare.

---

## The things that will bite

**`STORAGE_DIR` is ephemeral.** Render's filesystem resets on every deploy, so
uploaded CSVs vanish. The parsed rows survive in `import_rows.raw`, so no
imported data is lost — but the "your file said $1,800" answer is, which is the
thing that makes a disputed import resolvable. Fix by attaching a Render Disk
(paid, and it pins the service to one instance) or by implementing the R2 store
behind `ObjectStore`. R2 is the better answer and Phase 1a needs it anyway.

**`VITE_API_URL` is baked in at build time.** Vite inlines it. Changing it needs
a rebuild; restarting a static site does nothing. If the app is calling the
wrong API after a change, that is why.

**`WEB_ORIGIN` must match exactly.** CORS is scoped to that one origin. A
trailing slash, or `https://app.haulq.ai` when the browser sends
`https://www.app.haulq.ai`, produces a CORS error that looks like an auth
problem.

**`AUTH_PROVIDER` must be `clerk` in production.** `DevAuthenticator` refuses to
construct when `NODE_ENV=production`, so getting this wrong fails the boot
rather than quietly serving header-trusting auth to the internet. That is
deliberate — a failed deploy is the good outcome here.

**Free web services sleep.** The first request after idle takes ~50 seconds
while the instance wakes. Fine for you, bad for a demo to Andrew. `haulq-api` is
on `starter` in the Blueprint for this reason; it is also what makes
`preDeployCommand` work.

**Clerk's webhook needs the API's public URL.** Point the Clerk endpoint at
`https://api.haulq.ai/webhooks/clerk` once the domain resolves. Until
`CLERK_WEBHOOK_SECRET` is set the endpoint returns 503 and accepts nothing,
which is intended — see [clerk-setup.md](clerk-setup.md).

---

## Rough cost

| | |
|---|---|
| `haulq-api` starter | $7/mo |
| `haulq-web` static | $0 |
| `haulq-db` free → basic | $0, then ~$6/mo |
| **Total** | **$7–13/mo** |

Build plan section 6 budgeted $25/mo for app hosting, so this sits inside it.
Section 7's rule — anything above ~$25 per carrier per month needs written
justification — is about per-carrier variable cost and is unaffected by this.

## Verifying it

```bash
curl https://api.haulq.ai/health      # {"status":"ok"}
curl https://api.haulq.ai/ready       # {"status":"ready","database":"ok"}
```

`/ready` actually queries Postgres. If it returns 503 the database connection is
wrong — check that Doppler is not overwriting `DATABASE_URL`.

Then open `app.haulq.ai` and walk the path: sign up, add a truck, enter costs,
import a CSV, reconcile. That exercises every service and the database in the
order a carrier would.
