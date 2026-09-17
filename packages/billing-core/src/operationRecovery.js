import { randomUUID } from 'node:crypto';
import { invariant } from './operationContract.js';
import { operationFromRow } from './operationStore.js';
import { withCreditTransaction } from './creditCore.js';

/** Recovery ownership is independent of external provider execution state. */
export function createOperationRecoveryStore({ db, leaseMs = 30000, retryDelayMs = 60000, maxAttempts = 8 }) {
  invariant(Number.isSafeInteger(leaseMs) && leaseMs > 0 && leaseMs <= 3600000);
  invariant(Number.isSafeInteger(retryDelayMs) && retryDelayMs > 0);
  invariant(Number.isSafeInteger(maxAttempts) && maxAttempts > 0 && maxAttempts <= 100);
  const pending = "financial_status NOT IN ('settled','no_charge','released')";
  const due = `${pending} AND NOT manual_review AND lease_expires_at<=clock_timestamp() AND next_recovery_at<=clock_timestamp()`;
  return {
    async list({ operationId = null, limit = 20 } = {}) {
      invariant(Number.isInteger(limit) && limit > 0 && limit <= 100);
      const { rows } = await db.query(`SELECT * FROM ai_operations WHERE ${due}
        AND ($1::uuid IS NULL OR id=$1) ORDER BY next_recovery_at,id LIMIT $2`, [operationId, limit]);
      return rows.map(operationFromRow);
    },
    async claim({ operationId, owner = randomUUID() }) {
      invariant(typeof owner === 'string' && owner.length > 0 && owner.length <= 120);
      return withCreditTransaction(db, async (client) => {
        const { rows: [row] } = await client.query(`SELECT * FROM ai_operations WHERE id=$1 AND ${due} FOR UPDATE SKIP LOCKED`, [operationId]);
        if (!row) return null;
        const { rows: [claimed] } = await client.query(`UPDATE ai_operations SET execution_epoch=execution_epoch+1,
          lease_owner=$2,lease_expires_at=clock_timestamp()+$3*interval '1 millisecond',recovery_attempts=recovery_attempts+1,
          updated_at=NOW() WHERE id=$1 RETURNING *`, [operationId, owner, leaseMs]);
        await client.query("INSERT INTO ai_recovery_events(operation_id,execution_epoch,action) VALUES($1,$2,'claimed')", [operationId, claimed.execution_epoch]);
        return operationFromRow(claimed);
      }, { trackCommitOutcome: true });
    },
    async heartbeat({ operationId, owner, expectedEpoch }) {
      const { rowCount } = await db.query(`UPDATE ai_operations SET lease_expires_at=clock_timestamp()+$4*interval '1 millisecond'
        WHERE id=$1 AND lease_owner=$2 AND execution_epoch=$3 AND lease_expires_at>clock_timestamp()`, [operationId, owner, expectedEpoch, leaseMs]);
      invariant(rowCount === 1, 'execution_lease_lost', 409);
    },
    async finish({ operationId, owner, expectedEpoch, action, reason = null }) {
      invariant(['settled','no_charge','released','deferred','manual_review'].includes(action));
      invariant(reason === null || (typeof reason === 'string' && reason.length <= 160));
      return withCreditTransaction(db, async (client) => {
        const { rows: [row] } = await client.query(`UPDATE ai_operations SET lease_owner=NULL,
          lease_expires_at=clock_timestamp(),next_recovery_at=clock_timestamp()+$4*interval '1 millisecond',
          recovery_error=$5,manual_review=($6='manual_review' OR recovery_attempts >= $7),updated_at=NOW()
          WHERE id=$1 AND lease_owner=$2 AND execution_epoch=$3 AND lease_expires_at>clock_timestamp() RETURNING *`,
        [operationId, owner, expectedEpoch, retryDelayMs, reason, action, maxAttempts]);
        invariant(row, 'execution_lease_lost', 409);
        await client.query('INSERT INTO ai_recovery_events(operation_id,execution_epoch,action,reason) VALUES($1,$2,$3,$4)',
          [operationId, expectedEpoch, row.manual_review ? 'manual_review' : action, reason]);
        return operationFromRow(row);
      }, { trackCommitOutcome: true });
    },
    async metrics() {
      const { rows: [row] } = await db.query(`SELECT count(*)::int AS pending,
        count(*) FILTER (WHERE manual_review)::int AS manual,
        count(*) FILTER (WHERE lease_expires_at<=clock_timestamp())::int AS expired_leases,
        COALESCE(max(EXTRACT(EPOCH FROM (clock_timestamp()-created_at))),0)::float8 AS oldest_seconds
        FROM ai_operations WHERE ${pending}`);
      return row;
    },
  };
}
