/**
 * Brokers.
 *
 * Most of a broker's record is written implicitly by `resolveBroker` when a
 * load names one — see `repositories/loads.ts` — and nothing here duplicates
 * that. What lives here are the things a carrier does on purpose: setting
 * the per-broker detention free time (`PHASE_2_PLAN.md` section 7), and
 * checking a broker against FMCSA (`PHASE_0B_PLAN.md`, section 4's "0b-i").
 */

import { UpdateBrokerDetentionSchema, UpdateBrokerDocketSchema } from '@haulq/contracts';
import {
  BrokerError,
  getBroker,
  getLatestVerification,
  recordVerification,
  updateBrokerDetentionThreshold,
  updateBrokerDocket,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { FmcsaError, lookupCarrier } from '../integrations/fmcsa.ts';
import { HttpError, requireRole, requireScope } from '../plugins/request-context.ts';

function rethrow(err: unknown): never {
  if (err instanceof BrokerError) {
    throw new HttpError(err.code === 'not_found' ? 404 : 400, err.code, err.explanation);
  }
  throw err;
}

export async function brokerRoutes(app: FastifyInstance) {
  app.patch('/v1/brokers/:id/detention-threshold', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id } = request.params as { id: string };

    const parsed = UpdateBrokerDetentionSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'invalid_request',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      );
    }

    try {
      return await updateBrokerDetentionThreshold(s, id, parsed.data.freeMinutes);
    } catch (err) {
      rethrow(err);
    }
  });

  /** Put a broker's MC/USDOT number on file — see `updateBrokerDocket`'s own comment. */
  app.patch('/v1/brokers/:id/docket', async (request) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id } = request.params as { id: string };

    const parsed = UpdateBrokerDocketSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'invalid_request',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      );
    }

    try {
      return await updateBrokerDocket(s, id, parsed.data);
    } catch (err) {
      rethrow(err);
    }
  });

  /**
   * Check a broker against FMCSA and record the result.
   *
   * Not a driver action — same role gate as the detention threshold. Refuses
   * a broker with no MC or DOT number on file rather than guessing which the
   * carrier meant, since `lookupCarrier` cannot pick a number that isn't
   * there.
   */
  app.post('/v1/brokers/:id/verify', async (request, reply) => {
    const s = await requireScope(request);
    requireRole(request, 'owner', 'dispatcher');
    const { id } = request.params as { id: string };

    if (!app.env.FMCSA_WEBKEY) {
      throw new HttpError(
        503,
        'verify_not_configured',
        'Broker verification is not configured on this deployment.',
      );
    }

    const broker = await getBroker(s, id);
    if (!broker) throw new HttpError(404, 'not_found', 'That broker is not on this account.');

    const query = broker.mcNumber ?? broker.usdotNumber;
    if (!query) {
      throw new HttpError(
        422,
        'no_docket_number',
        `${broker.name} has no MC or USDOT number on file to check.`,
      );
    }

    let result;
    try {
      result = app.env.FMCSA_BASE_URL
        ? await lookupCarrier(query, app.env.FMCSA_WEBKEY, app.env.FMCSA_BASE_URL)
        : await lookupCarrier(query, app.env.FMCSA_WEBKEY);
    } catch (err) {
      if (err instanceof FmcsaError) {
        request.log.warn({ err: err.message, brokerId: id }, 'FMCSA lookup failed');
        throw new HttpError(502, 'verify_upstream_failed', 'FMCSA did not answer. Try again shortly.');
      }
      throw err;
    }

    const verification = await recordVerification(s, {
      brokerId: id,
      source: 'FMCSA QCMobile',
      operatingStatus: result.operatingStatus,
      legalName: result.legalName,
      dbaName: result.dbaName,
      raw: result.raw,
    });

    return reply.code(201).send({ verification, found: result.found });
  });

  /**
   * Both the docket numbers on file and the latest check, in one response —
   * the screen that shows one always wants the other, and it is the same
   * broker row read either way.
   */
  app.get('/v1/brokers/:id/verification', async (request) => {
    const s = await requireScope(request);
    const { id } = request.params as { id: string };

    const broker = await getBroker(s, id);
    if (!broker) throw new HttpError(404, 'not_found', 'That broker is not on this account.');

    const verification = await getLatestVerification(s, id);
    return {
      mcNumber: broker.mcNumber,
      usdotNumber: broker.usdotNumber,
      verification: verification ?? null,
    };
  });
}
