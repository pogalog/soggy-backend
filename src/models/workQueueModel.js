"use strict";

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function toDateOnlyString(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function toIsoString(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}

function toWorkUnits(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0;
}

function getWorkItemSnapshots(items) {
  return items
    .map((item) => ({
      lineId: item.lineId,
      productId: item.productId,
      variantId: item.variantId || null,
      variantLabel: item.variantLabel || null,
      optionSummary: item.optionSummary || null,
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      workUnits: toWorkUnits(item.workUnits)
    }))
    .filter((item) => item.workUnits > 0);
}

function mapReservation(row, allocations = []) {
  if (!row) return null;

  return {
    id: row.id,
    creatorId: row.creator_id,
    cartSessionId: row.cart_session_id,
    orderId: row.order_id || null,
    stripeCheckoutSessionId: row.stripe_checkout_session_id || null,
    status: row.status,
    totalWorkUnits: Number(row.total_work_units),
    shipByDate: toDateOnlyString(row.ship_by_date),
    itemsSnapshot: Array.isArray(row.items_snapshot) ? row.items_snapshot : [],
    reservedAt: toIsoString(row.reserved_at),
    expiresAt: toIsoString(row.expires_at),
    allocations: allocations.map((allocation) => ({
      workDate: toDateOnlyString(allocation.work_date),
      slotCount: Number(allocation.slot_count),
      displayOrder: Number(allocation.display_order || 0)
    }))
  };
}

async function getWorkQueueSettings(client) {
  const result = await client.query(
    `
      SELECT
        settings.default_creator_id,
        settings.reservation_ttl_minutes,
        settings.scheduling_horizon_days
      FROM work_queue_settings settings
      WHERE settings.id = true
      LIMIT 1
    `
  );

  if (result.rowCount === 0 || !result.rows[0].default_creator_id) {
    throw withStatusError("Work queue settings are not configured", 503);
  }

  return {
    defaultCreatorId: result.rows[0].default_creator_id,
    reservationTtlMinutes: Number(result.rows[0].reservation_ttl_minutes || 20),
    schedulingHorizonDays: Number(result.rows[0].scheduling_horizon_days || 365)
  };
}

async function advisoryLockCreator(client, creatorId) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    [`work_queue:${creatorId}`]
  );
}

async function markExpiredReservations(client) {
  await client.query(
    `
      UPDATE work_reservations
      SET status = 'expired', updated_at = NOW()
      WHERE status = 'held'
        AND expires_at <= NOW()
    `
  );
}

async function releaseActiveCartReservations(client, { cartSessionId }) {
  await client.query(
    `
      UPDATE work_reservations
      SET
        status = 'released',
        released_at = NOW(),
        updated_at = NOW()
      WHERE cart_session_id = $1
        AND status = 'held'
        AND order_id IS NULL
    `,
    [cartSessionId]
  );
}

async function getAvailableSlotsForDate(client, { creatorId, workDate, excludeCartSessionId = null }) {
  const result = await client.query(
    `
      WITH capacity AS (
        SELECT COALESCE(
          (
            SELECT available_slots
            FROM creator_workday_overrides
            WHERE creator_id = $1
              AND work_date = $2::date
          ),
          (
            SELECT available_slots
            FROM creator_weekly_availability
            WHERE creator_id = $1
              AND day_of_week = EXTRACT(DOW FROM $2::date)::smallint
          ),
          0
        ) AS available_slots
      ),
      committed AS (
        SELECT COALESCE(SUM(slot_count), 0) AS used_slots
        FROM work_item_allocations
        WHERE creator_id = $1
          AND work_date = $2::date
      ),
      held AS (
        SELECT COALESCE(SUM(allocations.slot_count), 0) AS held_slots
        FROM work_reservation_allocations allocations
        JOIN work_reservations reservations
          ON reservations.id = allocations.reservation_id
        WHERE allocations.creator_id = $1
          AND allocations.work_date = $2::date
          AND reservations.status = 'held'
          AND reservations.expires_at > NOW()
          AND NOT (
            $3::text IS NOT NULL
            AND reservations.cart_session_id = $3
            AND reservations.order_id IS NULL
          )
      )
      SELECT
        capacity.available_slots,
        committed.used_slots,
        held.held_slots,
        GREATEST(0, capacity.available_slots - committed.used_slots - held.held_slots) AS remaining_slots
      FROM capacity, committed, held
    `,
    [creatorId, workDate, excludeCartSessionId || null]
  );

  return Number(result.rows[0]?.remaining_slots || 0);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

async function findSlotAllocations(
  client,
  { creatorId, totalWorkUnits, horizonDays, excludeCartSessionId = null }
) {
  const allocations = [];
  let remaining = totalWorkUnits;
  let cursor = addDays(new Date(), 1);
  const maxDays = Math.max(1, Number(horizonDays || 365));

  for (let dayOffset = 0; dayOffset < maxDays && remaining > 1e-9; dayOffset += 1) {
    const workDate = formatDateOnly(cursor);
    const availableSlots = await getAvailableSlotsForDate(client, {
      creatorId,
      workDate,
      excludeCartSessionId
    });
    const slotCount = Math.min(remaining, availableSlots);

    if (slotCount > 1e-9) {
      allocations.push({
        workDate,
        slotCount
      });
      remaining -= slotCount;
    }

    cursor = addDays(cursor, 1);
  }

  if (remaining > 1e-9) {
    throw withStatusError(
      "No production availability is currently available for this cart. Please try again later.",
      422
    );
  }

  return allocations;
}

async function getReservationAllocations(client, reservationId) {
  const result = await client.query(
    `
      SELECT work_date, slot_count, display_order
      FROM work_reservation_allocations
      WHERE reservation_id = $1
      ORDER BY work_date ASC, display_order ASC
    `,
    [reservationId]
  );

  return result.rows;
}

async function replaceReservationAllocations(client, { reservationId, creatorId, allocations }) {
  await client.query(
    "DELETE FROM work_reservation_allocations WHERE reservation_id = $1",
    [reservationId]
  );

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    await client.query(
      `
        INSERT INTO work_reservation_allocations (
          reservation_id,
          creator_id,
          work_date,
          slot_count,
          display_order,
          created_at
        )
        VALUES ($1, $2, $3::date, $4, $5, NOW())
      `,
      [reservationId, creatorId, allocation.workDate, allocation.slotCount, index]
    );
  }
}

async function reserveWorkForCart(pool, { cartSessionId, items }) {
  const snapshots = getWorkItemSnapshots(items);
  const totalWorkUnits = snapshots.reduce((sum, item) => sum + item.workUnits, 0);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const settings = await getWorkQueueSettings(client);
    await advisoryLockCreator(client, settings.defaultCreatorId);
    await markExpiredReservations(client);
    await releaseActiveCartReservations(client, { cartSessionId });

    if (totalWorkUnits <= 0) {
      await client.query("COMMIT");
      return null;
    }

    const allocations = await findSlotAllocations(client, {
      creatorId: settings.defaultCreatorId,
      totalWorkUnits,
      horizonDays: settings.schedulingHorizonDays
    });
    const shipByDate = allocations[allocations.length - 1].workDate;
    const expiresAtSql = `NOW() + ($5::integer * INTERVAL '1 minute')`;

    const reservationResult = await client.query(
      `
        INSERT INTO work_reservations (
          creator_id,
          cart_session_id,
          status,
          total_work_units,
          ship_by_date,
          items_snapshot,
          reserved_at,
          expires_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, 'held', $3, $4::date, $6::jsonb, NOW(), ${expiresAtSql}, NOW(), NOW())
        RETURNING *
      `,
      [
        settings.defaultCreatorId,
        cartSessionId,
        totalWorkUnits,
        shipByDate,
        settings.reservationTtlMinutes,
        JSON.stringify(snapshots)
      ]
    );

    const reservation = reservationResult.rows[0];
    await replaceReservationAllocations(client, {
      reservationId: reservation.id,
      creatorId: settings.defaultCreatorId,
      allocations
    });

    const reservationAllocations = await getReservationAllocations(client, reservation.id);
    await client.query("COMMIT");
    return mapReservation(reservation, reservationAllocations);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function estimateWorkForCart(pool, { cartSessionId, items }) {
  const snapshots = getWorkItemSnapshots(items);
  const totalWorkUnits = snapshots.reduce((sum, item) => sum + item.workUnits, 0);
  if (totalWorkUnits <= 0) {
    return null;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const settings = await getWorkQueueSettings(client);
    await advisoryLockCreator(client, settings.defaultCreatorId);
    await markExpiredReservations(client);

    const allocations = await findSlotAllocations(client, {
      creatorId: settings.defaultCreatorId,
      totalWorkUnits,
      horizonDays: settings.schedulingHorizonDays,
      excludeCartSessionId: cartSessionId
    });
    await client.query("COMMIT");

    return {
      creatorId: settings.defaultCreatorId,
      totalWorkUnits,
      shipByDate: allocations[allocations.length - 1].workDate,
      itemsSnapshot: snapshots,
      allocations: allocations.map((allocation, index) => ({
        workDate: allocation.workDate,
        slotCount: allocation.slotCount,
        displayOrder: index
      }))
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function attachReservationToCheckout(pool, { reservationId, cartSessionId, orderId, stripeCheckoutSessionId }) {
  if (!reservationId) return null;

  const result = await pool.query(
    `
      UPDATE work_reservations
      SET
        order_id = $3,
        stripe_checkout_session_id = $4,
        updated_at = NOW()
      WHERE id = $1
        AND cart_session_id = $2
        AND status = 'held'
      RETURNING *
    `,
    [reservationId, cartSessionId, orderId, stripeCheckoutSessionId || null]
  );

  return result.rows[0] || null;
}

function nextAllocationPortion(allocations, state, desiredUnits) {
  const parts = [];
  let remaining = desiredUnits;

  while (remaining > 1e-9 && state.index < allocations.length) {
    const allocation = allocations[state.index];
    const availableInAllocation = Number(allocation.slot_count) - state.usedInCurrent;
    const slotCount = Math.min(remaining, availableInAllocation);

    if (slotCount > 1e-9) {
      parts.push({
        workDate: toDateOnlyString(allocation.work_date),
        slotCount
      });
      remaining -= slotCount;
      state.usedInCurrent += slotCount;
    }

    if (Number(allocation.slot_count) - state.usedInCurrent <= 1e-9) {
      state.index += 1;
      state.usedInCurrent = 0;
    }
  }

  return parts;
}

async function consumeReservationForOrder(client, { orderId, stripeCheckoutSessionId }) {
  const reservationResult = await client.query(
    `
      SELECT *
      FROM work_reservations
      WHERE order_id = $1
        AND status = 'held'
      ORDER BY reserved_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [orderId]
  );

  if (reservationResult.rowCount === 0) {
    return null;
  }

  const reservation = reservationResult.rows[0];
  await advisoryLockCreator(client, reservation.creator_id);

  const itemsResult = await client.query(
    `
      SELECT line_id, work_units
      FROM order_items
      WHERE order_id = $1
        AND work_units > 0
      ORDER BY created_at ASC, line_id ASC
    `,
    [orderId]
  );
  const totalWorkUnits = itemsResult.rows.reduce(
    (sum, item) => sum + toWorkUnits(item.work_units),
    0
  );
  const reservationExpired = new Date(reservation.expires_at).getTime() <= Date.now();
  let allocations = await getReservationAllocations(client, reservation.id);

  if (reservationExpired && totalWorkUnits > 0) {
    const settings = await getWorkQueueSettings(client);
    const refreshedAllocations = await findSlotAllocations(client, {
      creatorId: reservation.creator_id,
      totalWorkUnits,
      horizonDays: settings.schedulingHorizonDays
    });
    await replaceReservationAllocations(client, {
      reservationId: reservation.id,
      creatorId: reservation.creator_id,
      allocations: refreshedAllocations
    });
    await client.query(
      `
        UPDATE work_reservations
        SET
          ship_by_date = $2::date,
          updated_at = NOW()
        WHERE id = $1
      `,
      [reservation.id, refreshedAllocations[refreshedAllocations.length - 1].workDate]
    );
    reservation.ship_by_date = refreshedAllocations[refreshedAllocations.length - 1].workDate;
    allocations = await getReservationAllocations(client, reservation.id);
  }

  const allocationState = { index: 0, usedInCurrent: 0 };
  for (let itemIndex = 0; itemIndex < itemsResult.rows.length; itemIndex += 1) {
    const item = itemsResult.rows[itemIndex];
    const workUnits = Number(item.work_units);
    const parts = nextAllocationPortion(allocations, allocationState, workUnits);
    const scheduledStartDate = parts[0]?.workDate || null;
    const scheduledEndDate = parts[parts.length - 1]?.workDate || null;

    const workItemResult = await client.query(
      `
        INSERT INTO order_work_items (
          order_id,
          line_id,
          creator_id,
          work_units,
          status,
          scheduled_start_date,
          scheduled_end_date,
          source_reservation_id,
          sort_order,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, 'scheduled', $5::date, $6::date, $7, $8, NOW(), NOW())
        ON CONFLICT (order_id, line_id) DO UPDATE
        SET
          creator_id = EXCLUDED.creator_id,
          work_units = EXCLUDED.work_units,
          status = EXCLUDED.status,
          scheduled_start_date = EXCLUDED.scheduled_start_date,
          scheduled_end_date = EXCLUDED.scheduled_end_date,
          source_reservation_id = EXCLUDED.source_reservation_id,
          updated_at = NOW()
        RETURNING id
      `,
      [
        orderId,
        item.line_id,
        reservation.creator_id,
        workUnits,
        scheduledStartDate,
        scheduledEndDate,
        reservation.id,
        itemIndex
      ]
    );

    const workItemId = workItemResult.rows[0].id;
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      await client.query(
        `
          INSERT INTO work_item_allocations (
            work_item_id,
            creator_id,
            work_date,
            slot_count,
            display_order,
            created_at
          )
          VALUES ($1, $2, $3::date, $4, $5, NOW())
          ON CONFLICT (work_item_id, work_date) DO UPDATE
          SET
            creator_id = EXCLUDED.creator_id,
            slot_count = EXCLUDED.slot_count,
            display_order = EXCLUDED.display_order
        `,
        [workItemId, reservation.creator_id, part.workDate, part.slotCount, partIndex]
      );
    }
  }

  await client.query(
    `
      UPDATE work_reservations
      SET
        status = 'consumed',
        stripe_checkout_session_id = COALESCE($2, stripe_checkout_session_id),
        consumed_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `,
    [reservation.id, stripeCheckoutSessionId || null]
  );

  await client.query(
    `
      UPDATE orders
      SET
        ship_by_date = COALESCE(ship_by_date, $2::date),
        work_scheduled_at = COALESCE(work_scheduled_at, NOW()),
        updated_at = NOW()
      WHERE id = $1
    `,
    [orderId, toDateOnlyString(reservation.ship_by_date)]
  );

  return mapReservation(reservation, allocations);
}

module.exports = {
  attachReservationToCheckout,
  consumeReservationForOrder,
  estimateWorkForCart,
  reserveWorkForCart
};
