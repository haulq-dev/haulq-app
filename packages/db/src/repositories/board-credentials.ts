/**
 * Board and ELD connections.
 *
 * `schema/tenancy.ts`'s module note on `board_credentials` has the reasoning
 * for the two secret shapes this file writes: `secretRef` for a Doppler
 * pointer nothing here creates yet, and the sealed `encrypted*Token` pair
 * for an OAuth connection like Motive's, where the API layer
 * (`apps/api/src/integrations/motive.ts`) does the actual key sealing before
 * calling in here — this file never sees a plaintext token.
 */

import { and, eq } from 'drizzle-orm';
import type { Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
import { boardCredentials } from '../schema/tenancy.ts';
import { withTransaction } from '../transaction.ts';

export type BoardCredential = typeof boardCredentials.$inferSelect;

/** Never the secret columns — a settings screen lists connections, not their contents. */
export type BoardCredentialSummary = Omit<
  BoardCredential,
  'secretRef' | 'encryptedAccessToken' | 'encryptedRefreshToken'
>;

const SUMMARY_COLUMNS = {
  id: boardCredentials.id,
  orgId: boardCredentials.orgId,
  board: boardCredentials.board,
  endUserEmail: boardCredentials.endUserEmail,
  tokenExpiresAt: boardCredentials.tokenExpiresAt,
  status: boardCredentials.status,
  lastVerifiedAt: boardCredentials.lastVerifiedAt,
  lastError: boardCredentials.lastError,
  carrierOwnedSeat: boardCredentials.carrierOwnedSeat,
  createdAt: boardCredentials.createdAt,
  updatedAt: boardCredentials.updatedAt,
  deletedAt: boardCredentials.deletedAt,
} as const;

export async function listBoardCredentials(s: Scope): Promise<BoardCredentialSummary[]> {
  return s.db.select(SUMMARY_COLUMNS).from(boardCredentials).where(eq(boardCredentials.orgId, s.ctx.orgId));
}

export async function getBoardCredential(s: Scope, board: string): Promise<BoardCredential | undefined> {
  const [row] = await s.db
    .select()
    .from(boardCredentials)
    .where(and(eq(boardCredentials.orgId, s.ctx.orgId), eq(boardCredentials.board, board)));
  return row;
}

export interface StoreOAuthCredentialInput {
  board: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  expiresAt: Date;
}

/**
 * Connect or reconnect an OAuth-based board. Upserts on `(org_id, board)` —
 * the same unique key `board_credentials_org_board_key` already enforces —
 * so reauthorizing an expired or revoked connection replaces it rather than
 * stacking a second row Track would then have to choose between.
 */
export async function storeOAuthCredential(
  s: Scope,
  input: StoreOAuthCredentialInput,
): Promise<BoardCredential> {
  return withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .insert(boardCredentials)
      .values({
        orgId: tx.ctx.orgId,
        board: input.board,
        encryptedAccessToken: input.encryptedAccessToken,
        encryptedRefreshToken: input.encryptedRefreshToken,
        tokenExpiresAt: input.expiresAt,
        status: 'active',
        lastVerifiedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [boardCredentials.orgId, boardCredentials.board],
        set: {
          encryptedAccessToken: input.encryptedAccessToken,
          encryptedRefreshToken: input.encryptedRefreshToken,
          tokenExpiresAt: input.expiresAt,
          status: 'active',
          lastVerifiedAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!row) throw new Error('board credential upsert returned nothing');

    await recordEvent(tx, 'board_credential.connected', {
      subjectId: row.id,
      payload: { board: input.board },
    });

    return row;
  });
}

/** After a refresh — same row, new sealed tokens, no new event: connecting is the news, refreshing is not. */
export async function updateOAuthTokens(
  s: Scope,
  id: string,
  input: { encryptedAccessToken: string; encryptedRefreshToken: string; expiresAt: Date },
): Promise<void> {
  await s.db
    .update(boardCredentials)
    .set({
      encryptedAccessToken: input.encryptedAccessToken,
      encryptedRefreshToken: input.encryptedRefreshToken,
      tokenExpiresAt: input.expiresAt,
      updatedAt: new Date(),
    })
    .where(and(eq(boardCredentials.id, id), eq(boardCredentials.orgId, s.ctx.orgId)));
}

export async function markCredentialFailed(s: Scope, id: string, error: string): Promise<void> {
  await withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .update(boardCredentials)
      .set({ status: 'failed', lastError: error, updatedAt: new Date() })
      .where(and(eq(boardCredentials.id, id), eq(boardCredentials.orgId, tx.ctx.orgId)))
      .returning();

    if (row) {
      await recordEvent(tx, 'board_credential.failed', {
        subjectId: row.id,
        payload: { board: row.board, error },
      });
    }
  });
}
