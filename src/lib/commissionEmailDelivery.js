"use strict";
const { createHash } = require("node:crypto");

async function deliverCommissionEmail(pool, { commissionId, action, message, send }) {
  const hash = createHash("sha256").update(JSON.stringify(message)).digest("hex");
  const keys = [commissionId, action, hash];
  const claim = await pool.query(`
    INSERT INTO commission_email_deliveries (commission_id, action, content_hash, status)
    VALUES ($1, $2, $3, 'sending')
    ON CONFLICT (commission_id, action, content_hash) DO UPDATE SET
      status = 'sending', updated_at = NOW(), last_error = NULL
      WHERE commission_email_deliveries.status = 'failed'
        OR (commission_email_deliveries.status = 'sending' AND commission_email_deliveries.updated_at < NOW() - interval '10 minutes')
    RETURNING status`, keys);
  if (!claim.rowCount) {
    const existing = await pool.query(`SELECT status FROM commission_email_deliveries
      WHERE commission_id = $1 AND action = $2 AND content_hash = $3`, keys);
    if (existing.rows[0]?.status === "sent") return { alreadySent: true };
    throw Object.assign(new Error("This email is already being sent. Please retry shortly."), { statusCode: 409 });
  }
  try {
    const result = await send(message);
    if (Array.isArray(result?.rejected) && result.rejected.length) throw new Error("The mail server rejected the recipient.");
    await pool.query(`UPDATE commission_email_deliveries SET status = 'sent', sent_at = NOW(), updated_at = NOW()
      WHERE commission_id = $1 AND action = $2 AND content_hash = $3`, keys);
    return { alreadySent: false };
  } catch (error) {
    await pool.query(`UPDATE commission_email_deliveries SET status = 'failed', last_error = $4, updated_at = NOW()
      WHERE commission_id = $1 AND action = $2 AND content_hash = $3`, [...keys, String(error.message).slice(0, 500)]);
    throw error;
  }
}

module.exports = { deliverCommissionEmail };
