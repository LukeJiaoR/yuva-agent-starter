const CREDIT_TYPES = new Set(["membership", "purchased"]);
const CREDIT_PAYMENT_TYPES = new Set(["credits", "subscription"]);
const ACTIVE_USAGE_STATUSES = new Set(["reserved", "generating"]);

function integer(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value, maxLength = 255) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function coreError(code, status = 409) {
  const error = new Error(code);
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  Object.defineProperty(error, "status", { value: status, enumerable: true });
  return error;
}

function assertCreditType(value) {
  if (!CREDIT_TYPES.has(value)) throw new Error("Invalid Credit type");
  return value;
}

export function creditGrantIsExpired(grant, now = Date.now()) {
  if (grant?.credit_type !== "membership" || !grant?.expires_at) return false;
  const expiresAt = new Date(grant.expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function normalizeFeatureKey(value) {
  const key = text(value, 80);
  if (!/^[a-z][a-z0-9_]{1,79}$/u.test(key)) throw new Error("Invalid Credit feature key");
  return key;
}

export function normalizeCreditBalance(row) {
  const membership = Math.max(0, integer(row?.membership_credits ?? row?.membership));
  const purchased = Math.max(0, integer(row?.purchased_credits ?? row?.purchased));
  const membershipReserved = Math.max(0, integer(
    row?.membership_reserved_credits ?? row?.membership_reserved,
  ));
  const purchasedReserved = Math.max(0, integer(
    row?.purchased_reserved_credits ?? row?.purchased_reserved,
  ));
  return {
    available: Math.max(0, integer(row?.available_credits ?? row?.available)),
    reserved: Math.max(0, integer(row?.reserved_credits ?? row?.reserved)),
    debt: Math.max(0, integer(row?.credit_debt ?? row?.debt)),
    membership,
    purchased,
    membership_reserved: membershipReserved,
    purchased_reserved: purchasedReserved,
  };
}

export async function withCreditTransaction(db, callback, { beforeCommit = null } = {}) {
  if (typeof db.release === "function" || typeof db.connect !== "function") {
    const result = await callback(db);
    beforeCommit?.();
    return result;
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    beforeCommit?.();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function lockCreditAccount(client, userId) {
  await client.query(
    `INSERT INTO credit_accounts (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const { rows: [account] } = await client.query(
    "SELECT * FROM credit_accounts WHERE user_id = $1 FOR UPDATE",
    [userId],
  );
  return account;
}

export async function lockPaymentAfterCreditAccount(client, paymentIdentity) {
  if (!paymentIdentity?.id) return null;
  const ownedCreditPayment = paymentIdentity.user_id && CREDIT_PAYMENT_TYPES.has(paymentIdentity.type);
  if (ownedCreditPayment) {
    await lockCreditAccount(client, paymentIdentity.user_id);
  }
  const { rows: [payment] } = await client.query(
    "SELECT * FROM payments WHERE id = $1 FOR UPDATE",
    [paymentIdentity.id],
  );
  const reloadedOwnedCreditPayment = payment?.user_id && CREDIT_PAYMENT_TYPES.has(payment?.type);
  if (payment && (ownedCreditPayment || reloadedOwnedCreditPayment)
    && (payment.user_id !== paymentIdentity.user_id || payment.type !== paymentIdentity.type)) {
    throw coreError("credit_payment_identity_changed", 409);
  }
  return payment || null;
}

function ledgerClassification(entryType, metadata) {
  const sourceType = text(metadata?.source_type, 40);
  if (entryType === "reserve") return { transactionType: "usage_reserve", direction: "debit" };
  if (entryType === "settle") return { transactionType: "usage_charge", direction: "debit" };
  if (entryType === "release") return { transactionType: "usage_release", direction: "credit" };
  if (entryType === "expire") return { transactionType: "expiration", direction: "debit" };
  if (entryType === "admin_grant") return { transactionType: "admin_adjustment", direction: "credit" };
  if (entryType === "admin_deduct") return { transactionType: "admin_adjustment", direction: "debit" };
  if (entryType === "admin_reversal") return { transactionType: "admin_reversal", direction: "credit" };
  if (entryType === "usage_refund") return { transactionType: "usage_refund", direction: "credit" };
  if (["refund", "revoke", "debt_created", "debt_repaid"].includes(entryType)) {
    return { transactionType: "refund_reversal", direction: entryType === "debt_repaid" ? "credit" : "debit" };
  }
  if (sourceType === "purchased_topup") return { transactionType: "purchase_grant", direction: "credit" };
  if (sourceType === "subscription_grant") return { transactionType: "subscription_grant", direction: "credit" };
  if (sourceType === "signup_grant") return { transactionType: "signup_grant", direction: "credit" };
  if (sourceType === "feedback_reward") return { transactionType: "feedback_reward", direction: "credit" };
  return { transactionType: "admin_adjustment", direction: "credit" };
}

export async function appendCreditTransaction(client, {
  userId,
  grantId = null,
  usageRequestId = null,
  creditType = null,
  entryType,
  availableDelta = 0,
  reservedDelta = 0,
  debtDelta = 0,
  account,
  idempotencyKey,
  reason = null,
  referenceId = null,
  sourceType = null,
  sourceId = null,
  expiresAt = null,
  metadata = {},
  transactionType = null,
  direction = null,
  reversalOfTransactionId = null,
}) {
  const classification = ledgerClassification(entryType, {
    ...metadata,
    source_type: sourceType || metadata?.source_type,
  });
  const finalTransactionType = transactionType || classification.transactionType;
  const finalDirection = direction || classification.direction;
  const amount = Math.max(
    Math.abs(integer(availableDelta)),
    Math.abs(integer(reservedDelta)),
    Math.abs(integer(debtDelta)),
  );
  const result = await client.query(
    `INSERT INTO credit_transactions (
       user_id, grant_id, usage_request_id, credit_type, direction, amount,
       transaction_type, status, source_type, source_id,
       available_delta, reserved_delta, debt_delta,
       available_after, reserved_after, debt_after,
       idempotency_key, expires_at, reason, reference_id, metadata,
       reversal_of_transaction_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'posted',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      userId,
      grantId,
      usageRequestId,
      creditType,
      finalDirection,
      amount,
      finalTransactionType,
      sourceType || metadata?.source_type || null,
      sourceId || usageRequestId || referenceId || null,
      integer(availableDelta),
      integer(reservedDelta),
      integer(debtDelta),
      integer(account.available_credits),
      integer(account.reserved_credits),
      integer(account.credit_debt),
      idempotencyKey,
      expiresAt,
      text(reason, 160) || null,
      referenceId,
      JSON.stringify(metadata || {}),
      reversalOfTransactionId,
    ],
  );
  return result?.rows?.[0]?.id || null;
}

export function creditGrantSpendOrderSql(alias = "") {
  const column = (name) => `${alias}${name}`;
  return `CASE WHEN ${column("credit_type")} = 'membership' THEN 0 ELSE 1 END,
    ${column("expires_at")} ASC NULLS LAST,
    ${column("granted_at")} ASC,
    ${column("id")} ASC`;
}

export async function readCreditBalance({ db, userId }) {
  const { rows: [row] } = await db.query(
    `SELECT a.available_credits, a.reserved_credits, a.credit_debt,
            COALESCE(SUM(g.remaining_credits) FILTER (
              WHERE g.status <> 'revoked' AND g.credit_type = 'membership'
            ), 0)::int AS membership_credits,
            COALESCE(SUM(g.remaining_credits) FILTER (
              WHERE g.status <> 'revoked' AND g.credit_type = 'purchased'
            ), 0)::int AS purchased_credits,
            COALESCE(SUM(g.reserved_credits) FILTER (
              WHERE g.status <> 'revoked' AND g.credit_type = 'membership'
            ), 0)::int AS membership_reserved_credits,
            COALESCE(SUM(g.reserved_credits) FILTER (
              WHERE g.status <> 'revoked' AND g.credit_type = 'purchased'
            ), 0)::int AS purchased_reserved_credits
       FROM credit_accounts a
       LEFT JOIN credit_grants g ON g.user_id = a.user_id
      WHERE a.user_id = $1
      GROUP BY a.user_id, a.available_credits, a.reserved_credits, a.credit_debt`,
    [userId],
  );
  return normalizeCreditBalance(row);
}

export async function getCreditBalance({ db, userId }) {
  await expireCreditGrants({ db, userId });
  return readCreditBalance({ db, userId });
}

async function readGrantLedger(client, { grantId, idempotencyKey, sourceType }) {
  const transactionType = ledgerClassification("grant", { source_type: sourceType }).transactionType;
  const { rows: [transaction] } = await client.query(
    `SELECT id, amount FROM credit_transactions
      WHERE grant_id = $1
        AND idempotency_key = $2
        AND transaction_type = $3
        AND status = 'posted'
      LIMIT 1`,
    [grantId, `ledger:${idempotencyKey}`, transactionType],
  );
  const amount = Number(transaction?.amount);
  if (!transaction?.id || !Number.isInteger(amount) || amount < 0) {
    throw coreError("credit_grant_ledger_unconfirmed", 503);
  }
  return { id: transaction.id, amount };
}

export async function grantCredits({
  db,
  userId,
  creditType,
  sourceType,
  credits,
  idempotencyKey,
  expiresAt = null,
  paymentReference = null,
  orderReference = null,
  productKey = null,
  subscriptionId = null,
  sourceId = null,
  metadata = {},
  includeTransaction = false,
}) {
  const normalizedCreditType = assertCreditType(creditType);
  const amount = integer(credits);
  if (amount <= 0) throw new Error("Credit grant must be positive");
  if (!idempotencyKey) throw new Error("Credit grant requires an idempotency key");
  if (normalizedCreditType === "purchased" && expiresAt) {
    throw new Error("Purchased Credits cannot expire");
  }
  const shouldIncludeTransaction = Boolean(includeTransaction || sourceType === "signup_grant");

  return withCreditTransaction(db, async (client) => {
    const accountBefore = await lockCreditAccount(client, userId);
    const { rows: [existing] } = await client.query(
      "SELECT id FROM credit_grants WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    if (existing) {
      const ledger = shouldIncludeTransaction
        ? await readGrantLedger(client, { grantId: existing.id, idempotencyKey, sourceType })
        : null;

      return {
        created: false,
        grantId: existing.id,
        ...(ledger ? { transactionId: ledger.id, amount: ledger.amount } : {}),
        balance: await readCreditBalance({ db: client, userId }),
      };
    }

    const debtRepaid = Math.min(integer(accountBefore.credit_debt), amount);
    const availableAdded = amount - debtRepaid;
    const { rows: [grant] } = await client.query(
      `INSERT INTO credit_grants (
         user_id, credit_type, source_type, original_credits, remaining_credits,
         expires_at, payment_reference, order_reference, product_key,
         subscription_id, source_id, idempotency_key, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       RETURNING id`,
      [
        userId,
        normalizedCreditType,
        sourceType,
        amount,
        availableAdded,
        expiresAt,
        paymentReference,
        orderReference,
        productKey,
        subscriptionId,
        sourceId,
        idempotencyKey,
        JSON.stringify({ ...metadata, debt_repaid: debtRepaid }),
      ],
    );
    const { rows: [account] } = await client.query(
      `UPDATE credit_accounts
          SET available_credits = available_credits + $2,
              credit_debt = credit_debt - $3,
              version = version + 1,
              updated_at = NOW()
        WHERE user_id = $1
        RETURNING *`,
      [userId, availableAdded, debtRepaid],
    );
    if (debtRepaid > 0) {
      await appendCreditTransaction(client, {
        userId,
        grantId: grant.id,
        creditType: normalizedCreditType,
        entryType: "debt_repaid",
        debtDelta: -debtRepaid,
        account: { ...account, available_credits: accountBefore.available_credits },
        idempotencyKey: `ledger:debt-repaid:${idempotencyKey}`,
        sourceType,
        sourceId,
        referenceId: paymentReference || sourceId,
        reason: "Incoming Credits repaid refund debt",
      });
    }
    await appendCreditTransaction(client, {
      userId,
      grantId: grant.id,
      creditType: normalizedCreditType,
      entryType: "grant",
      availableDelta: availableAdded,
      account,
      idempotencyKey: `ledger:${idempotencyKey}`,
      sourceType,
      sourceId,
      expiresAt,
      referenceId: paymentReference || orderReference || sourceId,
      reason: `Credit grant: ${sourceType}`,
      metadata: { ...metadata, source_type: sourceType, original_credits: amount, debt_repaid: debtRepaid },
    });
    const ledger = shouldIncludeTransaction
      ? await readGrantLedger(client, { grantId: grant.id, idempotencyKey, sourceType })
      : null;
    return {
      created: true,
      grantId: grant.id,
      ...(ledger ? { transactionId: ledger.id, amount: ledger.amount } : {}),
      balance: await readCreditBalance({ db: client, userId }),
    };

  });
}

export async function expireCreditGrants({ db, userId, now = new Date() }) {
  return withCreditTransaction(db, async (client) => {
    let account = await lockCreditAccount(client, userId);
    const { rows: grants } = await client.query(
      `SELECT * FROM credit_grants
        WHERE user_id = $1
          AND credit_type = 'membership'
          AND status = 'active'
          AND expires_at IS NOT NULL
          AND expires_at <= $2
          AND remaining_credits > 0
        ORDER BY expires_at, id
        FOR UPDATE`,
      [userId, now],
    );
    let expired = 0;
    for (const grant of grants) {
      const amount = integer(grant.remaining_credits);
      const { rows: [updated] } = await client.query(
        `UPDATE credit_accounts
            SET available_credits = available_credits - $2,
                version = version + 1,
                updated_at = NOW()
          WHERE user_id = $1 AND available_credits >= $2
          RETURNING *`,
        [userId, amount],
      );
      if (!updated) throw new Error("Credit expiration would break reconciliation");
      account = updated;
      await client.query(
        `UPDATE credit_grants
            SET remaining_credits = 0,
                status = CASE WHEN reserved_credits = 0 THEN 'expired' ELSE 'active' END,
                updated_at = NOW()
          WHERE id = $1`,
        [grant.id],
      );
      await appendCreditTransaction(client, {
        userId,
        grantId: grant.id,
        creditType: grant.credit_type,
        entryType: "expire",
        availableDelta: -amount,
        account,
        idempotencyKey: `expire:${grant.id}`,
        sourceType: grant.source_type,
        sourceId: grant.source_id,
        expiresAt: grant.expires_at,
        reason: "Membership Credit grant expired",
      });
      expired += amount;
    }
    return { expiredCredits: expired, balance: await readCreditBalance({ db: client, userId }) };
  });
}

async function loadUsageRequest(client, { userId, featureKey, clientRequestId, id = null, lock = false }) {
  const suffix = lock ? " FOR UPDATE" : "";
  const params = id ? [id, userId] : [userId, featureKey, clientRequestId];
  const where = id
    ? "id = $1 AND user_id = $2"
    : "user_id = $1 AND feature_key = $2 AND client_request_id = $3";
  const { rows: [request] } = await client.query(
    `SELECT * FROM credit_usage_requests WHERE ${where}${suffix}`,
    params,
  );
  return request || null;
}

export async function reserveFeatureCredits({
  db,
  userId,
  featureKey,
  clientRequestId,
  credits,
  chartId = null,
  pricingStrategy = "fixed",
  metadata = {},
  allowRetryOnReleased = true,
}) {
  const normalizedFeature = normalizeFeatureKey(featureKey);
  const reserveCredits = integer(credits);
  if (reserveCredits <= 0) throw new Error("Credit reservation must be positive");
  if (!clientRequestId) throw new Error("Credit reservation requires a client request id");
  if (!new Set(["fixed", "dynamic"]).has(pricingStrategy)) {
    throw new Error("Invalid Credit pricing strategy");
  }

  return withCreditTransaction(db, async (client) => {
    await expireCreditGrants({ db: client, userId });
    const account = await lockCreditAccount(client, userId);
    const existing = await loadUsageRequest(client, {
      userId,
      featureKey: normalizedFeature,
      clientRequestId,
    });
    let request = null;

    if (existing) {
      if (existing.status === "released" && allowRetryOnReleased) {
        if (integer(account.credit_debt) > 0) {
          return { kind: "debt", balance: await readCreditBalance({ db: client, userId }) };
        }
        if (integer(account.available_credits) < reserveCredits) {
          return { kind: "insufficient", balance: await readCreditBalance({ db: client, userId }) };
        }
        const nextAttemptNo = integer(existing.attempt_no || 1) + 1;
        const { rows: [reactivatedRequest] } = await client.query(
          `UPDATE credit_usage_requests
              SET status = 'generating',
                  attempt_no = $2,
                  reserved_credits = $3,
                  settled_credits = 0,
                  credits_released = 0,
                  billable_tokens = 0,
                  balance_before = $4,
                  balance_after = NULL,
                  result_id = NULL,
                  assistant_text = NULL,
                  failure_class = NULL,
                  started_at = NOW(),
                  completed_at = NULL,
                  settled_at = NULL,
                  updated_at = NOW(),
                  metadata = metadata || $5::jsonb
            WHERE id = $1
            RETURNING *`,
          [
            existing.id,
            nextAttemptNo,
            reserveCredits,
            integer(account.available_credits),
            JSON.stringify(metadata || {}),
          ],
        );
        request = reactivatedRequest;
      } else {
        return { kind: "existing", request: existing, balance: await readCreditBalance({ db: client, userId }) };
      }
    }

    if (!request) {
      if (integer(account.credit_debt) > 0) {
        return { kind: "debt", balance: await readCreditBalance({ db: client, userId }) };
      }
      if (integer(account.available_credits) < reserveCredits) {
        return { kind: "insufficient", balance: await readCreditBalance({ db: client, userId }) };
      }

      const idempotencyKey = `${normalizedFeature}:${clientRequestId}`;
      const { rows: [insertedRequest] } = await client.query(
        `INSERT INTO credit_usage_requests (
           user_id, feature_key, chart_id, client_request_id, idempotency_key,
           pricing_strategy, status, attempt_no, reserved_credits, balance_before,
           started_at, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,'generating',1,$7,$8,NOW(),$9::jsonb)
         RETURNING *`,
        [
          userId,
          normalizedFeature,
          chartId,
          clientRequestId,
          idempotencyKey,
          pricingStrategy,
          reserveCredits,
          integer(account.available_credits),
          JSON.stringify(metadata || {}),
        ],
      );
      request = insertedRequest;
    }
    const { rows: grants } = await client.query(
      `SELECT * FROM credit_grants
        WHERE user_id = $1
          AND status = 'active'
          AND remaining_credits > 0
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY ${creditGrantSpendOrderSql()}
        FOR UPDATE`,
      [userId],
    );
    let remaining = reserveCredits;
    const allocations = [];
    for (const grant of grants) {
      if (remaining <= 0) break;
      const take = Math.min(integer(grant.remaining_credits), remaining);
      if (take <= 0) continue;
      await client.query(
        `UPDATE credit_grants
            SET remaining_credits = remaining_credits - $2,
                reserved_credits = reserved_credits + $2,
                updated_at = NOW()
          WHERE id = $1`,
        [grant.id, take],
      );
      await client.query(
        `INSERT INTO credit_usage_allocations (usage_request_id, grant_id, reserved_credits, attempt_no)
         VALUES ($1,$2,$3,$4)`,
        [request.id, grant.id, take, integer(request.attempt_no || 1)],
      );
      allocations.push({ grantId: grant.id, creditType: grant.credit_type, credits: take });
      remaining -= take;
    }
    if (remaining !== 0) throw new Error("Credit account and grants are out of reconciliation");

    const { rows: [updatedAccount] } = await client.query(
      `UPDATE credit_accounts
          SET available_credits = available_credits - $2,
              reserved_credits = reserved_credits + $2,
              version = version + 1,
              updated_at = NOW()
        WHERE user_id = $1
        RETURNING *`,
      [userId, reserveCredits],
    );
    let cumulative = 0;
    for (const allocation of allocations) {
      cumulative += allocation.credits;
      await appendCreditTransaction(client, {
        userId,
        grantId: allocation.grantId,
        usageRequestId: request.id,
        creditType: allocation.creditType,
        entryType: "reserve",
        availableDelta: -allocation.credits,
        reservedDelta: allocation.credits,
        account: {
          ...updatedAccount,
          available_credits: integer(account.available_credits) - cumulative,
          reserved_credits: integer(account.reserved_credits) + cumulative,
        },
        idempotencyKey: `reserve:${request.id}:${request.attempt_no || 1}:${allocation.grantId}`,
        sourceType: normalizedFeature,
        sourceId: clientRequestId,
        reason: `Reserve Credits for ${normalizedFeature}`,
      });
    }
    return {
      kind: "reserved",
      request,
      balance: await readCreditBalance({ db: client, userId }),
    };
  });
}

export async function settleFeatureCredits({
  db,
  requestId,
  userId,
  creditsUsed,
  resultId = null,
  persistResult = null,
  metadata = {},
}) {
  const charge = integer(creditsUsed);
  if (charge <= 0) throw new Error("Settled Credits must be positive");
  return withCreditTransaction(db, async (client) => {
    await expireCreditGrants({ db: client, userId });
    const accountBefore = await lockCreditAccount(client, userId);
    const request = await loadUsageRequest(client, { id: requestId, userId, lock: true });
    if (!request) throw new Error("Credit usage request not found");
    if (request.status === "settled") {
      return { replay: true, request, balance: await readCreditBalance({ db: client, userId }) };
    }
    if (!ACTIVE_USAGE_STATUSES.has(request.status)) {
      throw new Error(`Credit usage request cannot settle from ${request.status}`);
    }
    if (charge > integer(request.reserved_credits)) {
      throw new Error("Credit charge exceeds reservation");
    }

    const { rows: allocations } = await client.query(
      `SELECT a.*, g.credit_type, g.source_type, g.expires_at
         FROM credit_usage_allocations a
         JOIN credit_grants g ON g.id = a.grant_id
        WHERE a.usage_request_id = $1 AND a.attempt_no = $2
        ORDER BY ${creditGrantSpendOrderSql("g.")}
        FOR UPDATE OF a, g`,
      [request.id, integer(request.attempt_no || 1)],
    );
    let toSettle = charge;
    let totalRelease = 0;
    let availableRelease = 0;
    const outcomes = [];
    for (const allocation of allocations) {
      const reserved = integer(allocation.reserved_credits);
      const settled = Math.min(reserved, toSettle);
      const released = reserved - settled;
      const expired = creditGrantIsExpired(allocation);
      await client.query(
        `UPDATE credit_usage_allocations
            SET settled_credits = $3, released_credits = $4, updated_at = NOW()
          WHERE usage_request_id = $1 AND grant_id = $2 AND attempt_no = $5`,
        [request.id, allocation.grant_id, settled, released, integer(request.attempt_no || 1)],
      );
      await client.query(
        `UPDATE credit_grants
            SET reserved_credits = reserved_credits - $2,
                remaining_credits = remaining_credits + CASE WHEN $4 THEN 0 ELSE $3 END,
                status = CASE
                  WHEN $4 AND reserved_credits - $2 = 0 THEN 'expired'
                  WHEN NOT $4 AND remaining_credits + $3 = 0 AND reserved_credits - $2 = 0
                    THEN 'exhausted'
                  ELSE status
                END,
                updated_at = NOW()
          WHERE id = $1`,
        [allocation.grant_id, reserved, released, expired],
      );
      outcomes.push({ ...allocation, settled, released, expired });
      toSettle -= settled;
      totalRelease += released;
      if (!expired) availableRelease += released;
    }
    if (toSettle !== 0) throw new Error("Credit allocation settlement mismatch");

    const persistedResult = typeof persistResult === "function"
      ? await persistResult(client, request)
      : null;
    const resolvedResultId = persistedResult?.id || resultId;

    const { rows: [account] } = await client.query(
      `UPDATE credit_accounts
          SET available_credits = available_credits + $2,
              reserved_credits = reserved_credits - $3,
              version = version + 1,
              updated_at = NOW()
        WHERE user_id = $1
        RETURNING *`,
      [userId, availableRelease, integer(request.reserved_credits)],
    );
    let availableSnapshot = integer(accountBefore.available_credits);
    let reservedSnapshot = integer(accountBefore.reserved_credits);
    for (const outcome of outcomes) {
      if (outcome.settled > 0) {
        reservedSnapshot -= outcome.settled;
        await appendCreditTransaction(client, {
          userId,
          grantId: outcome.grant_id,
          usageRequestId: request.id,
          creditType: outcome.credit_type,
          entryType: "settle",
          reservedDelta: -outcome.settled,
          account: { ...account, available_credits: availableSnapshot, reserved_credits: reservedSnapshot },
          idempotencyKey: `settle:${request.id}:${request.attempt_no || 1}:${outcome.grant_id}`,
          sourceType: request.feature_key,
          sourceId: request.client_request_id,
          reason: `Settle ${request.feature_key} Credit usage`,
          metadata,
        });
      }
      if (outcome.released > 0) {
        reservedSnapshot -= outcome.released;
        if (!outcome.expired) availableSnapshot += outcome.released;
        await appendCreditTransaction(client, {
          userId,
          grantId: outcome.grant_id,
          usageRequestId: request.id,
          creditType: outcome.credit_type,
          entryType: outcome.expired ? "expire" : "release",
          availableDelta: outcome.expired ? 0 : outcome.released,
          reservedDelta: -outcome.released,
          account: { ...account, available_credits: availableSnapshot, reserved_credits: reservedSnapshot },
          idempotencyKey: `release-unused:${request.id}:${request.attempt_no || 1}:${outcome.grant_id}`,
          sourceType: request.feature_key,
          sourceId: request.client_request_id,
          reason: outcome.expired
            ? `Expire unused ${request.feature_key} reservation after Membership period ended`
            : `Release unused ${request.feature_key} reservation`,
          metadata,
        });
      }
    }
    // A Membership grant may expire while a request holds a reservation. The
    // reserved portion remains valid for this request, but any unused portion
    // released after expiry must expire in the same transaction.
    const postExpiry = await expireCreditGrants({ db: client, userId });
    const finalBalance = postExpiry.balance;
    const { rows: [settledRequest] } = await client.query(
      `UPDATE credit_usage_requests
          SET status = 'settled', settled_credits = $2, credits_released = $3,
              result_id = $4, balance_after = $5,
              metadata = metadata || $6::jsonb,
              completed_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        request.id,
        charge,
        totalRelease,
        resolvedResultId,
        finalBalance.available,
        JSON.stringify(metadata || {}),
      ],
    );
    return {
      replay: false,
      request: settledRequest,
      result: persistedResult,
      balance: finalBalance,
    };
  });
}

export async function releaseFeatureCredits({
  db,
  requestId,
  userId,
  failureClass = "feature_failed",
  metadata = {},
  persistUsageEvent = null,
  allowReconciliationRequired = false,
}) {
  return withCreditTransaction(db, async (client) => {
    await expireCreditGrants({ db: client, userId });
    const accountBefore = await lockCreditAccount(client, userId);
    const request = await loadUsageRequest(client, { id: requestId, userId, lock: true });
    if (!request) throw new Error("Credit usage request not found");
    if (request.status === "released" || request.status === "settled") {
      return { replay: true, request, balance: await readCreditBalance({ db: client, userId }) };
    }
    if (
      !ACTIVE_USAGE_STATUSES.has(request.status)
      && !(allowReconciliationRequired && request.status === "reconciliation_required")
    ) {
      throw new Error(`Credit usage request cannot release from ${request.status}`);
    }
    const { rows: allocations } = await client.query(
      `SELECT a.*, g.credit_type, g.source_type, g.expires_at
         FROM credit_usage_allocations a
         JOIN credit_grants g ON g.id = a.grant_id
        WHERE a.usage_request_id = $1 AND a.attempt_no = $2
        ORDER BY ${creditGrantSpendOrderSql("g.")}
        FOR UPDATE OF a, g`,
      [request.id, integer(request.attempt_no || 1)],
    );
    let released = 0;
    let availableReleased = 0;
    const releases = [];
    for (const allocation of allocations) {
      const amount = integer(allocation.reserved_credits)
        - integer(allocation.settled_credits)
        - integer(allocation.released_credits);
      if (amount <= 0) continue;
      const expired = creditGrantIsExpired(allocation);
      await client.query(
        `UPDATE credit_usage_allocations
            SET released_credits = released_credits + $3, updated_at = NOW()
          WHERE usage_request_id = $1 AND grant_id = $2 AND attempt_no = $4`,
        [request.id, allocation.grant_id, amount, integer(request.attempt_no || 1)],
      );
      await client.query(
        `UPDATE credit_grants
            SET reserved_credits = reserved_credits - $2,
                remaining_credits = remaining_credits + CASE WHEN $3 THEN 0 ELSE $2 END,
                status = CASE WHEN $3 THEN 'expired' ELSE 'active' END,
                updated_at = NOW()
          WHERE id = $1`,
        [allocation.grant_id, amount, expired],
      );
      releases.push({ ...allocation, amount, expired });
      released += amount;
      if (!expired) availableReleased += amount;
    }
    const { rows: [account] } = await client.query(
      `UPDATE credit_accounts
          SET available_credits = available_credits + $2,
              reserved_credits = reserved_credits - $3,
              version = version + 1,
              updated_at = NOW()
        WHERE user_id = $1
        RETURNING *`,
      [userId, availableReleased, released],
    );
    let availableSnapshot = integer(accountBefore.available_credits);
    let reservedSnapshot = integer(accountBefore.reserved_credits);
    for (const release of releases) {
      reservedSnapshot -= release.amount;
      if (!release.expired) availableSnapshot += release.amount;
      await appendCreditTransaction(client, {
        userId,
        grantId: release.grant_id,
        usageRequestId: request.id,
        creditType: release.credit_type,
        entryType: release.expired ? "expire" : "release",
        availableDelta: release.expired ? 0 : release.amount,
        reservedDelta: -release.amount,
        account: { ...account, available_credits: availableSnapshot, reserved_credits: reservedSnapshot },
        idempotencyKey: `release:${request.id}:${request.attempt_no || 1}:${release.grant_id}`,
        sourceType: request.feature_key,
        sourceId: request.client_request_id,
        reason: release.expired
          ? `Expire ${request.feature_key} reservation after Membership period ended`
          : `${request.feature_key} failed: ${failureClass}`,
        metadata: { ...metadata, failure_class: failureClass },
      });
    }
    if (typeof persistUsageEvent === "function") {
      await persistUsageEvent(client, request);
    }
    // Failure releases the reservation, then immediately expires any returned
    // Membership Credits whose grant period elapsed during generation.
    const postExpiry = await expireCreditGrants({ db: client, userId });
    const finalBalance = postExpiry.balance;
    const { rows: [releasedRequest] } = await client.query(
      `UPDATE credit_usage_requests
          SET status = 'released', failure_class = $2, settled_credits = 0,
              credits_released = $3, balance_after = $4,
              metadata = metadata || $5::jsonb,
              completed_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        request.id,
        failureClass,
        released,
        finalBalance.available,
        JSON.stringify(metadata || {}),
      ],
    );
    return {
      replay: false,
      request: releasedRequest,
      balance: finalBalance,
    };
  });
}

export async function revokeCreditGrant({
  db,
  userId,
  paymentReference,
  expectedProductKey = null,
  expectedProviderSubscriptionId = null,
  expectedOrderReference = null,
  refundReference,
  reason = "payment_refund",
}) {
  if (!paymentReference || !refundReference) throw coreError("refund_reference_required", 400);
  if (String(expectedProductKey || "").startsWith("credit_pack_") && !expectedOrderReference) {
    throw coreError("refund_order_reference_required", 409);
  }
  if (String(expectedProductKey || "").startsWith("membership_") && !expectedProviderSubscriptionId) {
    throw coreError("refund_subscription_reference_required", 409);
  }
  return withCreditTransaction(db, async (client) => {
    let accountBefore = await lockCreditAccount(client, userId);
    if (expectedProviderSubscriptionId) {
      const { rows: [subscription] } = await client.query(
        `SELECT * FROM credit_subscriptions
          WHERE provider_subscription_id = $1
          FOR UPDATE`,
        [expectedProviderSubscriptionId],
      );
      if (!subscription) {
        return { created: false, reason: "grant_not_found", balance: await readCreditBalance({ db: client, userId }) };
      }
      if (subscription.user_id !== userId
        || (expectedProductKey && subscription.product_key !== expectedProductKey)) {
        throw coreError("refund_subscription_binding_mismatch", 409);
      }
    }
    const { rows: matchedGrants } = await client.query(
      `SELECT g.* FROM credit_grants g
        WHERE g.user_id = $1
          AND (g.payment_reference = $2 OR g.order_reference = $2)
          AND ($3::text IS NULL OR g.product_key = $3)
          AND ($4::text IS NULL OR EXISTS (
            SELECT 1 FROM credit_subscriptions s
             WHERE s.id = g.subscription_id
               AND s.provider_subscription_id = $4
          ))
          AND ($5::text IS NULL OR g.order_reference = $5)
        ORDER BY g.granted_at, g.id
        FOR UPDATE OF g`,
      [
        userId,
        paymentReference,
        expectedProductKey,
        expectedProviderSubscriptionId,
        expectedOrderReference,
      ],
    );
    if (matchedGrants.length === 0) {
      return { created: false, reason: "grant_not_found", balance: await readCreditBalance({ db: client, userId }) };
    }
    const { rows: [existing] } = await client.query(
      "SELECT id FROM credit_transactions WHERE idempotency_key = $1",
      [`revoke:${refundReference}`],
    );
    if (existing) {
      return { created: false, reason: "replayed", balance: await readCreditBalance({ db: client, userId }) };
    }
    if (matchedGrants.every((grant) => grant.status === "revoked")) {
      return { created: false, reason: "already_revoked", balance: await readCreditBalance({ db: client, userId }) };
    }
    if (matchedGrants.some((grant) => grant.status === "revoked")) {
      return {
        created: false,
        reason: "reconciliation_required",
        balance: await readCreditBalance({ db: client, userId }),
      };
    }

    let grants = matchedGrants;
    const grantIds = grants.map((grant) => grant.id);
    if (grants.some((grant) => integer(grant.reserved_credits) > 0)) {
      const requestsById = new Map();
      for (const grant of grants) {
        if (integer(grant.reserved_credits) <= 0) continue;
        const { rows: activeRequests } = await client.query(
        `SELECT r.id, r.status
           FROM credit_usage_requests r
           JOIN credit_usage_allocations a ON a.usage_request_id = r.id
          WHERE a.grant_id = $1
            AND a.reserved_credits > a.settled_credits + a.released_credits
          FOR UPDATE OF r`,
          [grant.id],
        );
        for (const request of activeRequests) requestsById.set(request.id, request);
      }
      for (const request of requestsById.values()) {
        if (!ACTIVE_USAGE_STATUSES.has(request.status) && request.status !== "reconciliation_required") {
          continue;
        }
        await releaseFeatureCredits({
          db: client,
          requestId: request.id,
          userId,
          failureClass: "refund_during_generation",
          metadata: { refund_reference: refundReference },
          allowReconciliationRequired: true,
        });
      }
      const { rows: refreshedGrants } = await client.query(
        `SELECT * FROM credit_grants
          WHERE id = ANY($1::uuid[])
          ORDER BY granted_at, id
          FOR UPDATE`,
        [grantIds],
      );
      if (refreshedGrants.length !== grantIds.length) {
        throw new Error("Refund grant set changed during Credit revocation");
      }
      grants = refreshedGrants;
      if (grants.some((grant) => integer(grant.reserved_credits) > 0)) {
        await client.query(
          `UPDATE credit_usage_requests r
              SET status = 'reconciliation_required',
                  failure_class = 'refund_during_generation',
                  updated_at = NOW()
            WHERE r.id IN (
              SELECT usage_request_id FROM credit_usage_allocations
               WHERE grant_id = ANY($1::uuid[])
                 AND reserved_credits > settled_credits + released_credits
            )`,
          [grantIds],
        );
        return {
          created: false,
          reason: "reconciliation_required",
          balance: await readCreditBalance({ db: client, userId }),
        };
      }
      accountBefore = await lockCreditAccount(client, userId);
    }

    const grantAccounting = [];
    for (const grant of grants) {
      const { rows: [usage] } = await client.query(
        `SELECT
           COALESCE((
             SELECT SUM(settled_credits)
               FROM credit_usage_allocations
              WHERE grant_id = $1
           ), 0)::int AS settled_credits,
           COALESCE((
             SELECT SUM(-available_delta)
               FROM credit_transactions
              WHERE grant_id = $1
                AND transaction_type = 'refund_reversal'
                AND available_delta < 0
                AND metadata ? 'refunded_grant_id'
           ), 0)::int AS refund_offset_credits`,
        [grant.id],
      );
      grantAccounting.push({
        grant,
        remaining: integer(grant.remaining_credits),
        consumed: Math.max(
          0,
          integer(usage?.settled_credits)
            + integer(usage?.refund_offset_credits)
            + integer(grant.metadata?.debt_repaid),
        ),
      });
    }
    const grantRevoked = grantAccounting.reduce((sum, item) => sum + item.remaining, 0);
    const consumed = grantAccounting.reduce((sum, item) => sum + item.consumed, 0);
    const { rows: offsetGrants } = await client.query(
      `SELECT * FROM credit_grants
        WHERE user_id = $1
          AND id <> ALL($2::uuid[])
          AND status = 'active'
          AND remaining_credits > 0
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY ${creditGrantSpendOrderSql()}
        FOR UPDATE`,
      [userId, grantIds],
    );
    let offsetRemaining = consumed;
    const offsets = [];
    for (const offsetGrant of offsetGrants) {
      if (offsetRemaining <= 0) break;
      const amount = Math.min(integer(offsetGrant.remaining_credits), offsetRemaining);
      if (amount <= 0) continue;
      await client.query(
        `UPDATE credit_grants
            SET remaining_credits = remaining_credits - $2,
                status = CASE
                  WHEN remaining_credits - $2 = 0 AND reserved_credits = 0
                    THEN 'exhausted'
                  ELSE status
                END,
                updated_at = NOW()
          WHERE id = $1`,
        [offsetGrant.id, amount],
      );
      offsets.push({ grant: offsetGrant, amount });
      offsetRemaining -= amount;
    }
    const offsetRevoked = offsets.reduce((sum, item) => sum + item.amount, 0);
    const debtCreated = Math.max(0, consumed - offsetRevoked);
    const availableRevoked = grantRevoked + offsetRevoked;
    const { rows: [account] } = await client.query(
      `UPDATE credit_accounts
          SET available_credits = available_credits - $2,
              credit_debt = credit_debt + $3,
              version = version + 1,
              updated_at = NOW()
        WHERE user_id = $1 AND available_credits >= $2
        RETURNING *`,
      [userId, availableRevoked, debtCreated],
    );
    if (!account) throw new Error("Refund revocation would break Credit reconciliation");
    for (const item of grantAccounting) {
      await client.query(
        `UPDATE credit_grants
            SET remaining_credits = 0, status = 'revoked', updated_at = NOW(),
                metadata = metadata || $2::jsonb
          WHERE id = $1`,
        [item.grant.id, JSON.stringify({
          refund_reference: refundReference,
          revoke_reason: reason,
          consumed_credits: item.consumed,
          group_consumed_credits: consumed,
          offset_revoked: offsetRevoked,
          debt_created: debtCreated,
        })],
      );
    }
    let availableSnapshot = integer(accountBefore.available_credits);
    for (const [index, item] of grantAccounting.entries()) {
      availableSnapshot -= item.remaining;
      await appendCreditTransaction(client, {
        userId,
        grantId: item.grant.id,
        creditType: item.grant.credit_type,
        entryType: "revoke",
        availableDelta: -item.remaining,
        account: {
          ...account,
          available_credits: availableSnapshot,
          credit_debt: accountBefore.credit_debt,
        },
        idempotencyKey: index === 0
          ? `revoke:${refundReference}`
          : `revoke:${refundReference}:${item.grant.id}`,
        sourceType: item.grant.source_type,
        sourceId: item.grant.source_id,
        referenceId: refundReference,
        reason: "Revoke refunded Credit grant",
        metadata: {
          consumed_credits: item.consumed,
          group_consumed_credits: consumed,
          offset_revoked: offsetRevoked,
          refund_reference: refundReference,
        },
      });
    }
    for (const offset of offsets) {
      availableSnapshot -= offset.amount;
      await appendCreditTransaction(client, {
        userId,
        grantId: offset.grant.id,
        creditType: offset.grant.credit_type,
        entryType: "revoke",
        availableDelta: -offset.amount,
        account: {
          ...account,
          available_credits: availableSnapshot,
          credit_debt: accountBefore.credit_debt,
        },
        idempotencyKey: `revoke-offset:${refundReference}:${offset.grant.id}`,
        sourceType: offset.grant.source_type,
        sourceId: offset.grant.source_id,
        referenceId: refundReference,
        reason: "Recover consumed refunded Credits from available balance",
        metadata: {
          refunded_grant_id: grantAccounting[0].grant.id,
          refunded_grant_ids: grantIds,
          refund_reference: refundReference,
        },
      });
    }
    if (debtCreated > 0) {
      await appendCreditTransaction(client, {
        userId,
        grantId: grantAccounting[0].grant.id,
        creditType: grantAccounting[0].grant.credit_type,
        entryType: "debt_created",
        debtDelta: debtCreated,
        account,
        idempotencyKey: `debt:${refundReference}`,
        sourceType: grantAccounting[0].grant.source_type,
        sourceId: grantAccounting[0].grant.source_id,
        referenceId: refundReference,
        reason: "Refund exceeded remaining Credits",
      });
    }
    return {
      created: true,
      revoked: availableRevoked,
      grantRevoked,
      revokedGrantIds: grantIds,
      offsetRevoked,
      debtCreated,
      balance: await readCreditBalance({ db: client, userId }),
    };
  });
}

export async function reconcileCreditAccount({ db, userId }) {
  const { rows: [row] } = await db.query(
    `SELECT a.available_credits, a.reserved_credits, a.credit_debt,
            COALESCE(SUM(g.remaining_credits), 0)::int AS grant_available,
            COALESCE(SUM(g.reserved_credits), 0)::int AS grant_reserved,
            COALESCE(SUM(g.remaining_credits) FILTER (
              WHERE g.credit_type = 'membership'
            ), 0)::int AS membership_credits,
            COALESCE(SUM(g.remaining_credits) FILTER (
              WHERE g.credit_type = 'purchased'
            ), 0)::int AS purchased_credits,
            COALESCE(SUM(g.reserved_credits) FILTER (
              WHERE g.credit_type = 'membership'
            ), 0)::int AS membership_reserved_credits,
            COALESCE(SUM(g.reserved_credits) FILTER (
              WHERE g.credit_type = 'purchased'
            ), 0)::int AS purchased_reserved_credits
       FROM credit_accounts a
       LEFT JOIN credit_grants g ON g.user_id = a.user_id AND g.status <> 'revoked'
      WHERE a.user_id = $1
      GROUP BY a.user_id, a.available_credits, a.reserved_credits, a.credit_debt`,
    [userId],
  );
  if (!row) {
    return { ok: true, ...normalizeCreditBalance(null), grantAvailable: 0, grantReserved: 0 };
  }
  const balance = normalizeCreditBalance(row);
  const grantAvailable = integer(row.grant_available);
  const grantReserved = integer(row.grant_reserved);
  return {
    ok: balance.available === grantAvailable && balance.reserved === grantReserved,
    ...balance,
    grantAvailable,
    grantReserved,
  };
}

function positiveCredits(value, code) {
  const amount = integer(value, -1);
  if (amount <= 0) throw coreError(code, 400);
  return amount;
}

function requireId(value, code) {
  const normalized = text(value, 255);
  if (!normalized) throw coreError(code, 400);
  return normalized;
}

async function updateCreditAccount(client, userId, availableDelta, reservedDelta = 0, debtDelta = 0) {
  const predicates = ["user_id = $1"];
  if (availableDelta < 0) predicates.push("available_credits >= -$2");
  const { rows: [account] } = await client.query(
    `UPDATE credit_accounts
        SET available_credits = available_credits + $2,
            reserved_credits = reserved_credits + $3,
            credit_debt = credit_debt + $4,
            version = version + 1,
            updated_at = NOW()
      WHERE ${predicates.join(" AND ")}
      RETURNING *`,
    [userId, availableDelta, reservedDelta, debtDelta],
  );
  if (!account) throw coreError("credit_reconciliation_required", 409);
  return account;
}

function grantLockQuery({ userIdParam = "$1", creditTypeParam = null } = {}) {
  const creditType = creditTypeParam ? ` AND credit_type = ${creditTypeParam}` : "";
  return `SELECT * FROM credit_grants
        WHERE user_id = ${userIdParam}
          AND status = 'active'
          AND remaining_credits > 0
          AND (expires_at IS NULL OR expires_at > NOW())${creditType}
        ORDER BY ${creditGrantSpendOrderSql()}
        FOR UPDATE`;
}

export async function deductAvailableCredits({
  db,
  userId,
  creditType = null,
  credits,
  idempotencyKey,
  reason,
  referenceId = null,
  sourceId = null,
  metadata = {},
}) {
  const amount = positiveCredits(credits, "credit_deduction_invalid_amount");
  const normalizedUserId = requireId(userId, "credit_deduction_target_required");
  const normalizedIdempotencyKey = requireId(idempotencyKey, "credit_deduction_idempotency_required");
  const normalizedReason = requireId(reason, "credit_deduction_reason_required");
  if (creditType !== null) assertCreditType(creditType);

  return withCreditTransaction(db, async (client) => {
    const accountBefore = await lockCreditAccount(client, normalizedUserId);
    const params = creditType === null ? [normalizedUserId] : [normalizedUserId, creditType];
    const { rows: grants } = await client.query(
      grantLockQuery({ creditTypeParam: creditType === null ? null : "$2" }),
      params,
    );
    const availableInGrants = (grants || []).reduce((sum, grant) => sum + integer(grant.remaining_credits), 0);
    if (availableInGrants < amount || integer(accountBefore?.available_credits) < amount) {
      throw coreError("credit_insufficient_available", 409);
    }

    let remaining = amount;
    const deductions = [];
    for (const grant of grants) {
      if (remaining <= 0) break;
      const take = Math.min(integer(grant.remaining_credits), remaining);
      if (take <= 0) continue;
      const { rows: [updatedGrant] } = await client.query(
        `UPDATE credit_grants
            SET remaining_credits = remaining_credits - $2,
                status = CASE
                  WHEN remaining_credits - $2 = 0 AND reserved_credits = 0 THEN 'exhausted'
                  ELSE status
                END,
                updated_at = NOW()
          WHERE id = $1 AND remaining_credits >= $2
          RETURNING *`,
        [grant.id, take],
      );
      if (!updatedGrant) throw coreError("credit_reconciliation_required", 409);
      deductions.push({ grant, amount: take });
      remaining -= take;
    }
    if (remaining !== 0) throw coreError("credit_reconciliation_required", 409);

    const account = await updateCreditAccount(client, normalizedUserId, -amount);
    let availableSnapshot = integer(accountBefore.available_credits);
    const transactionIds = [];
    for (const [index, deduction] of deductions.entries()) {
      availableSnapshot -= deduction.amount;
      const transactionId = await appendCreditTransaction(client, {
        userId: normalizedUserId,
        grantId: deduction.grant.id,
        creditType: deduction.grant.credit_type,
        entryType: "admin_deduct",
        transactionType: "admin_adjustment",
        direction: "debit",
        availableDelta: -deduction.amount,
        account: { ...account, available_credits: availableSnapshot },
        idempotencyKey: `${normalizedIdempotencyKey}:${deduction.grant.id}:${index}`,
        reason: normalizedReason,
        referenceId,
        sourceType: "admin_adjustment",
        sourceId: sourceId || referenceId,
        metadata,
      });
      if (transactionId) transactionIds.push(transactionId);
    }
    return {
      deductedCredits: amount,
      debtCreated: 0,
      grantIds: deductions.map(({ grant }) => grant.id),
      transactionIds,
      balance: await readCreditBalance({ db: client, userId: normalizedUserId }),
    };
  });
}

async function loadUsageRequestForAdmin(client, usageRequestId, lock = false) {
  const { rows: [request] } = await client.query(
    `SELECT * FROM credit_usage_requests WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [usageRequestId],
  );
  return request || null;
}

export async function refundSettledUsage({
  db,
  usageRequestId,
  idempotencyKey,
  reason,
  metadata = {},
  now = new Date(),
}) {
  const normalizedUsageRequestId = requireId(usageRequestId, "credit_usage_refund_target_required");
  const normalizedIdempotencyKey = requireId(idempotencyKey, "credit_usage_refund_idempotency_required");
  const normalizedReason = requireId(reason, "credit_usage_refund_reason_required");

  return withCreditTransaction(db, async (client) => {
    const unlockedRequest = await loadUsageRequestForAdmin(client, normalizedUsageRequestId);
    if (!unlockedRequest) throw coreError("credit_usage_not_found", 404);
    const accountBefore = await lockCreditAccount(client, unlockedRequest.user_id);
    const request = await loadUsageRequestForAdmin(client, normalizedUsageRequestId, true);
    if (!request) throw coreError("credit_usage_not_found", 404);
    if (request.status === "refunded") throw coreError("credit_usage_already_refunded", 409);
    if (request.status !== "settled") throw coreError("credit_usage_not_settled", 409);

    const { rows: allocations } = await client.query(
      `SELECT a.*, g.credit_type, g.source_type, g.expires_at, g.status AS grant_status,
              g.remaining_credits, g.original_credits, g.reserved_credits
         FROM credit_usage_allocations a
         JOIN credit_grants g ON g.id = a.grant_id
        WHERE a.usage_request_id = $1
        ORDER BY ${creditGrantSpendOrderSql("g.")}
        FOR UPDATE OF a, g`,
      [request.id],
    );
    if (!allocations || allocations.length === 0) throw coreError("credit_usage_reconciliation_required", 409);

    let restoredCredits = 0;
    let expiredCredits = 0;
    let expiredAllocationCount = 0;
    const outcomes = [];
    for (const allocation of allocations) {
      const settled = integer(allocation.settled_credits);
      if (settled <= 0) continue;
      if (allocation.grant_status === "revoked") throw coreError("credit_usage_reconciliation_required", 409);
      const expired = creditGrantIsExpired(allocation, now);
      if (expired) {
        expiredCredits += settled;
        expiredAllocationCount += 1;
        outcomes.push({ allocation, amount: settled, expired: true });
        continue;
      }
      const { rows: [updatedGrant] } = await client.query(
        `UPDATE credit_grants
            SET remaining_credits = remaining_credits + $2,
                status = 'active',
                updated_at = NOW()
          WHERE id = $1
            AND status <> 'revoked'
            AND remaining_credits + reserved_credits + $2 <= original_credits
          RETURNING *`,
        [allocation.grant_id, settled],
      );
      if (!updatedGrant) throw coreError("credit_usage_reconciliation_required", 409);
      restoredCredits += settled;
      outcomes.push({ allocation, amount: settled, expired: false });
    }

    const account = restoredCredits > 0
      ? await updateCreditAccount(client, request.user_id, restoredCredits)
      : accountBefore;
    let availableSnapshot = integer(accountBefore.available_credits);
    const transactionIds = [];
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.expired) continue;
      availableSnapshot += outcome.amount;
      const transactionId = await appendCreditTransaction(client, {
        userId: request.user_id,
        grantId: outcome.allocation.grant_id,
        usageRequestId: request.id,
        creditType: outcome.allocation.credit_type,
        entryType: "usage_refund",
        transactionType: "usage_refund",
        direction: "credit",
        availableDelta: outcome.amount,
        account: { ...account, available_credits: availableSnapshot },
        idempotencyKey: `${normalizedIdempotencyKey}:${outcome.allocation.grant_id}:${index}`,
        reason: normalizedReason,
        referenceId: request.id,
        sourceType: request.feature_key,
        sourceId: request.client_request_id,
        metadata: { ...metadata, expired_credits: expiredCredits },
      });
      if (transactionId) transactionIds.push(transactionId);
    }
    const { rows: [refundedRequest] } = await client.query(
      `UPDATE credit_usage_requests
          SET status = 'refunded',
              metadata = metadata || $2::jsonb,
              completed_at = COALESCE(completed_at, NOW()),
              updated_at = NOW()
        WHERE id = $1 AND status = 'settled'
        RETURNING *`,
      [request.id, JSON.stringify({ ...metadata, admin_refund_expired_credits: expiredCredits })],
    );
    return {
      usageRequestId: request.id,
      refundedCredits: restoredCredits + expiredCredits,
      restoredCredits,
      expiredCredits,
      expiredAllocationCount,
      transactionIds,
      request: refundedRequest || { ...request, status: "refunded" },
      balance: await readCreditBalance({ db: client, userId: request.user_id }),
    };
  });
}

async function loadTransaction(client, transactionId, lock = false) {
  const { rows: [transaction] } = await client.query(
    `SELECT * FROM credit_transactions WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [transactionId],
  );
  return transaction || null;
}

export async function reverseAdministrativeTransaction({
  db,
  transactionId,
  idempotencyKey,
  reason,
  referenceId = null,
  metadata = {},
}) {
  const normalizedTransactionId = requireId(transactionId, "credit_reversal_target_required");
  const normalizedIdempotencyKey = requireId(idempotencyKey, "credit_reversal_idempotency_required");
  const normalizedReason = requireId(reason, "credit_reversal_reason_required");

  return withCreditTransaction(db, async (client) => {
    const unlocked = await loadTransaction(client, normalizedTransactionId);
    if (!unlocked) throw coreError("credit_transaction_not_found", 404);
    const accountBefore = await lockCreditAccount(client, unlocked.user_id);
    const original = await loadTransaction(client, normalizedTransactionId, true);
    if (!original) throw coreError("credit_transaction_not_found", 404);
    const { rows: [existingReversal] } = await client.query(
      `SELECT id FROM credit_transactions
        WHERE reversal_of_transaction_id = $1
        FOR UPDATE`,
      [original.id],
    );
    if (existingReversal) throw coreError("credit_transaction_already_reversed", 409);
    if (original.transaction_type === "usage_charge") {
      throw coreError("credit_reverse_use_refund_usage", 409);
    }
    if (["purchase_grant", "subscription_grant"].includes(original.transaction_type)) {
      throw coreError("credit_reverse_finance_refund_required", 409);
    }
    if (original.transaction_type !== "admin_adjustment" && original.transaction_type !== "feedback_reward") {
      throw coreError("credit_reverse_not_allowed", 409);
    }
    const originalDelta = integer(original.available_delta);
    if (originalDelta === 0 || integer(original.reserved_delta) !== 0 || integer(original.debt_delta) !== 0) {
      throw coreError("credit_reverse_reconciliation_required", 409);
    }
    if (!original.grant_id) throw coreError("credit_reverse_reconciliation_required", 409);
    const { rows: [grant] } = await client.query(
      `SELECT * FROM credit_grants WHERE id = $1 FOR UPDATE`,
      [original.grant_id],
    );
    if (!grant || grant.status === "revoked" || integer(grant.reserved_credits) > 0) {
      throw coreError("credit_reverse_reconciliation_required", 409);
    }
    const reversalDelta = -originalDelta;
    const amount = Math.abs(originalDelta);
    if (reversalDelta < 0 && integer(grant.remaining_credits) < amount) {
      throw coreError("credit_reverse_reconciliation_required", 409);
    }
    if (reversalDelta > 0 && grant.credit_type === "membership" && creditGrantIsExpired(grant)) {
      throw coreError("credit_reverse_reconciliation_required", 409);
    }
    const { rows: [updatedGrant] } = await client.query(
      `UPDATE credit_grants
          SET remaining_credits = remaining_credits + $2,
              status = CASE
                WHEN remaining_credits + $2 = 0 AND reserved_credits = 0 THEN 'exhausted'
                ELSE 'active'
              END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [grant.id, reversalDelta],
    );
    if (!updatedGrant) throw coreError("credit_reverse_reconciliation_required", 409);
    const account = await updateCreditAccount(client, original.user_id, reversalDelta);
    const transactionIdCreated = await appendCreditTransaction(client, {
      userId: original.user_id,
      grantId: original.grant_id,
      creditType: original.credit_type,
      entryType: "admin_reversal",
      transactionType: "admin_reversal",
      direction: reversalDelta >= 0 ? "credit" : "debit",
      availableDelta: reversalDelta,
      account,
      idempotencyKey: normalizedIdempotencyKey,
      reason: normalizedReason,
      referenceId: referenceId || original.reference_id || original.id,
      sourceType: "admin_reversal",
      sourceId: original.id,
      metadata,
      reversalOfTransactionId: original.id,
    });
    return {
      reversedCredits: amount,
      reversalOfTransactionId: original.id,
      reversalTransactionId: transactionIdCreated,
      transactionIds: transactionIdCreated ? [transactionIdCreated] : [],
      grantId: original.grant_id,
      balance: await readCreditBalance({ db: client, userId: original.user_id }),
    };
  });
}

export async function expireCreditGrantById({
  db,
  grantId,
  idempotencyKey,
  reason,
  metadata = {},
  now = new Date(),
}) {
  const normalizedGrantId = requireId(grantId, "credit_expiration_target_required");
  const normalizedIdempotencyKey = requireId(idempotencyKey, "credit_expiration_idempotency_required");
  const normalizedReason = requireId(reason, "credit_expiration_reason_required");

  return withCreditTransaction(db, async (client) => {
    const unlocked = await client.query("SELECT * FROM credit_grants WHERE id = $1", [normalizedGrantId]);
    const initialGrant = unlocked?.rows?.[0];
    if (!initialGrant) throw coreError("credit_grant_not_found", 404);
    const accountBefore = await lockCreditAccount(client, initialGrant.user_id);
    const { rows: [grant] } = await client.query(
      `SELECT * FROM credit_grants WHERE id = $1 FOR UPDATE`,
      [normalizedGrantId],
    );
    if (!grant) throw coreError("credit_grant_not_found", 404);
    if (grant.credit_type !== "membership") throw coreError("credit_expiration_membership_only", 409);
    if (grant.status !== "active" || integer(grant.remaining_credits) <= 0) {
      throw coreError("credit_grant_terminal", 409);
    }
    if (integer(grant.reserved_credits) > 0) throw coreError("credit_grant_reserved_reconciliation_required", 409);
    const amount = integer(grant.remaining_credits);
    const account = await updateCreditAccount(client, grant.user_id, -amount);
    const { rows: [updatedGrant] } = await client.query(
      `UPDATE credit_grants
          SET remaining_credits = 0, status = 'expired', updated_at = NOW()
        WHERE id = $1 AND status = 'active' AND reserved_credits = 0
        RETURNING *`,
      [grant.id],
    );
    if (!updatedGrant) throw coreError("credit_expiration_reconciliation_required", 409);
    const transactionId = await appendCreditTransaction(client, {
      userId: grant.user_id,
      grantId: grant.id,
      creditType: grant.credit_type,
      entryType: "expire",
      transactionType: "expiration",
      direction: "debit",
      availableDelta: -amount,
      account,
      idempotencyKey: normalizedIdempotencyKey,
      reason: normalizedReason,
      referenceId: grant.id,
      sourceType: grant.source_type,
      sourceId: grant.source_id,
      expiresAt: grant.expires_at || now,
      metadata,
    });
    return {
      grantId: grant.id,
      expiredCredits: amount,
      transactionId,
      transactionIds: transactionId ? [transactionId] : [],
      balance: await readCreditBalance({ db: client, userId: grant.user_id }),
      accountBefore,
    };
  });
}
