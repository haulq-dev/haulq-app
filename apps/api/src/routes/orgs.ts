/**
 * Onboarding, carrier profile and operating facts.
 *
 * `POST /v1/orgs` is the exception to every other route in the codebase: it
 * authenticates a person rather than a tenant, because it is the request that
 * creates the tenant. Everything below it uses the normal `requireScope`.
 */

import {
  CreateOrgSchema,
  OperatingFactsSchema,
  UpdateCarrierProfileSchema,
  hasErrors,
  isCompleteForScoring,
  validateOperatingFacts,
} from '@haulq/contracts';
import {
  createOrg,
  getCarrierProfile,
  getOrg,
  onboardingStatus,
  OnboardingError,
  saveOperatingFacts,
  updateCarrierProfile,
} from '@haulq/db';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

export async function orgRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Create an account.
   *
   * No `requireScope` — there is no org yet. `authenticateUser` refuses agent
   * actors outright, which is guardrail 5 applied at the one place the usual
   * `refuseAgentCommitment` check has no tenant to run in.
   */
  server.post(
    '/v1/orgs',
    { schema: { tags: ['Orgs'], summary: 'Create an account', body: CreateOrgSchema } },
    async (request, reply) => {
      const authed = await app.authenticator.authenticateUser(request.headers);
      if (!authed) {
        throw new HttpError(
          401,
          'unauthenticated',
          'Sign in before creating an account.',
        );
      }

      try {
        const { org, profile } = await createOrg(
          app.db,
          {
            actor: authed.actor,
            correlationId: randomUUID(),
            ipAddress: request.ip,
            userAgent:
              typeof request.headers['user-agent'] === 'string'
                ? request.headers['user-agent']
                : undefined,
          },
          request.body,
        );
        return reply.code(201).send({ org, profile });
      } catch (err) {
        if (err instanceof OnboardingError) {
          throw new HttpError(409, 'onboarding_failed', err.explanation);
        }
        throw err;
      }
    },
  );

  // --- profile -------------------------------------------------------------

  server.get(
    '/v1/org/profile',
    { schema: { tags: ['Orgs'], summary: 'Get the carrier profile' } },
    async (request) => {
      const s = await requireScope(request);
      const profile = await getCarrierProfile(s);
      if (!profile) {
        throw new HttpError(
          404,
          'not_found',
          'This account has no carrier profile yet.',
        );
      }
      // slug lives on orgs, not carrier_profiles. Included here — rather than a
      // separate endpoint — because the one thing it is for today, the HaulQ
      // Docs inbound address, is exactly the kind of account fact this route
      // already answers.
      const org = await getOrg(s);
      return { ...profile, slug: org?.slug ?? null };
    },
  );

  server.patch(
    '/v1/org/profile',
    { schema: { tags: ['Orgs'], summary: 'Update the carrier profile', body: UpdateCarrierProfileSchema } },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'dispatcher');

      try {
        return await updateCarrierProfile(s, request.body);
      } catch (err) {
        if (err instanceof OnboardingError) {
          throw new HttpError(404, 'not_found', err.explanation);
        }
        throw err;
      }
    },
  );

  // --- operating facts -----------------------------------------------------

  server.get(
    '/v1/org/operating-facts',
    { schema: { tags: ['Orgs'], summary: 'Get stated operating costs' } },
    async (request) => {
      const s = await requireScope(request);
      const profile = await getCarrierProfile(s);
      const facts = (profile?.operatingFacts ?? {}) as Record<string, number>;

      // The warnings ride along with the values so the form can render them on
      // load, not only after an edit. A carrier who set a bad number six months
      // ago should see the warning every time they open the screen.
      return {
        facts,
        issues: validateOperatingFacts(facts),
        completeForScoring: isCompleteForScoring(facts),
        reconciledAt: profile?.operatingFactsReconciledAt ?? null,
      };
    },
  );

  /**
   * Save operating facts.
   *
   * Errors block; warnings are returned with a 200 and the saved values. That
   * asymmetry is the whole design — see the note in `operating-facts.ts`. An
   * owner running a niche operation may legitimately have numbers outside the
   * usual range, and refusing them would make the product useless to him.
   */
  server.put(
    '/v1/org/operating-facts',
    { schema: { tags: ['Orgs'], summary: 'Save stated operating costs', body: OperatingFactsSchema } },
    async (request) => {
      const s = await requireScope(request);
      requireRole(request, 'owner', 'accountant');
      const input = request.body;

      const issues = validateOperatingFacts(input);
      if (hasErrors(issues)) {
        const explanation = issues
          .filter((i) => i.severity === 'error')
          .map((i) => i.message)
          .join(' ');
        return {
          saved: false,
          issues,
          explanation,
        };
      }

      const merged = await saveOperatingFacts(s, input, {
        completeForScoring: isCompleteForScoring(input),
      });

      return {
        saved: true,
        facts: merged,
        issues,
        completeForScoring: isCompleteForScoring(merged as Record<string, number>),
      };
    },
  );

  // --- onboarding ----------------------------------------------------------

  server.get(
    '/v1/onboarding',
    { schema: { tags: ['Orgs'], summary: 'Onboarding checklist status' } },
    async (request) => {
      const s = await requireScope(request);
      return onboardingStatus(s);
    },
  );
}
