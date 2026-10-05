import test from "node:test";
import assert from "node:assert/strict";
import {
  createRecurringForm, normalizeRecurringForm, computePendingRecurringExpenses,
  recurringExpenseToDoc, postRecurringExpense, skipRecurringPeriod, applyRecurringActivity,
} from "../src/recurringExpenses.js";

const template = (overrides = {}) => ({
  id: "subscription", title: "サブスク", amount: 1000, category: "other",
  startMonth: "2026-01", dayOfMonth: 1, intervalMonths: 1,
  active: true, memo: "共有", amountVaries: false, ...overrides,
});

test("posts only due missing periods, including months missed while the app was closed", () => {
  const items = [template(), template({ id: "bimonthly", dayOfMonth: 15, intervalMonths: 2 }), template({ id: "paused", active: false })];
  const existing = [
    { id: "rec_subscription_2026-01" }, { id: "rec_subscription_2026-02" },
    { id: "rec_bimonthly_2026-01" }, { id: "manual-income", type: "income", amount: 10000 },
  ];
  assert.deepEqual(computePendingRecurringExpenses(items, existing, new Date(2026, 2, 15)).map(entry => entry.expId), ["rec_subscription_2026-03", "rec_bimonthly_2026-03"]);
});

test("clamps the 31st to month end and includes leap day", () => {
  const item = template({ startMonth: "2024-02", dayOfMonth: 31 });
  assert.deepEqual(computePendingRecurringExpenses([item], [], new Date(2024, 1, 28)), []);
  assert.equal(computePendingRecurringExpenses([item], [], new Date(2024, 1, 29))[0].dueDay, 29);
  const pending = computePendingRecurringExpenses([template({ startMonth: "2026-02", dayOfMonth: 31 })], [], new Date(2026, 1, 28));
  assert.equal(recurringExpenseToDoc(pending[0]).date, "2026-02-28");
});

test("does not post before the due date or before the start month", () => {
  assert.deepEqual(computePendingRecurringExpenses([template({ startMonth: "2026-03", dayOfMonth: 31 })], [], new Date(2026, 2, 15)), []);
  assert.deepEqual(computePendingRecurringExpenses([template({ startMonth: "2027-01" })], [], new Date(2026, 11, 31)), []);
});

test("all supported intervals remain anchored to the start month across years", () => {
  for (const intervalMonths of [1, 2, 3, 6, 12]) {
    const pending = computePendingRecurringExpenses([template({ startMonth: "2025-11", intervalMonths })], [], new Date(2026, 10, 1));
    assert.equal(pending.length, 12 / intervalMonths + 1);
    assert.equal(pending[0].period, "2025-11");
    assert.equal(pending.at(-1).period, "2026-11");
  }
});

test("resuming a cancelled subscription after six months excludes every paused billing date", () => {
  const item = applyRecurringActivity(template(), false, new Date(2026, 0, 15));
  const existing = [{ id: "rec_subscription_2026-01" }];
  assert.deepEqual(computePendingRecurringExpenses([item], existing, new Date(2026, 7, 1)), []);
  const resumed = applyRecurringActivity(item, true, new Date(2026, 7, 1));
  assert.deepEqual(computePendingRecurringExpenses([resumed], existing, new Date(2026, 7, 1)).map(entry => entry.period), ["2026-08"]);
});

test("resuming after this month's billing day waits for the next scheduled billing day", () => {
  const paused = applyRecurringActivity(template({ startMonth: "2026-07" }), false, new Date(2026, 6, 15));
  const resumed = applyRecurringActivity(paused, true, new Date(2026, 9, 5));
  const existing = [{ id: "rec_subscription_2026-07" }];
  assert.deepEqual(computePendingRecurringExpenses([resumed], existing, new Date(2026, 9, 5)), []);
  assert.deepEqual(computePendingRecurringExpenses([resumed], existing, new Date(2026, 10, 1)).map(entry => entry.period), ["2026-11"]);
});

test("missed expenses from active periods remain eligible before and after a pause", () => {
  const paused = applyRecurringActivity(template(), false, new Date(2026, 1, 15));
  const resumed = applyRecurringActivity(paused, true, new Date(2026, 4, 15));
  assert.deepEqual(computePendingRecurringExpenses([resumed], [], new Date(2026, 5, 1)).map(entry => entry.period), ["2026-01", "2026-02", "2026-06"]);
});

test("repeated pause and resume cycles retain all excluded periods and deletion markers", () => {
  let item = template({ skippedPeriods: ["2026-01"] });
  item = applyRecurringActivity(item, false, new Date(2026, 1, 1));
  item = applyRecurringActivity(item, true, new Date(2026, 3, 1));
  item = applyRecurringActivity(item, false, new Date(2026, 4, 1));
  item = applyRecurringActivity(item, true, new Date(2026, 6, 1));
  assert.deepEqual(item.skippedPeriods, ["2026-01"]);
  assert.deepEqual(computePendingRecurringExpenses([item], [], new Date(2026, 7, 1)).map(entry => entry.period), ["2026-04", "2026-07", "2026-08"]);
});

test("pausing on a billing date excludes it and resuming on a billing date includes it", () => {
  const paused = applyRecurringActivity(template(), false, new Date(2026, 1, 1));
  const resumed = applyRecurringActivity(paused, true, new Date(2026, 2, 1));
  assert.deepEqual(computePendingRecurringExpenses([resumed], [{ id: "rec_subscription_2026-01" }], new Date(2026, 2, 1)).map(entry => entry.period), ["2026-03"]);
});

test("leap-day billing inside a paused range is excluded while the next month remains eligible", () => {
  const paused = applyRecurringActivity(template({ startMonth: "2024-02", dayOfMonth: 31 }), false, new Date(2024, 1, 28));
  const resumed = applyRecurringActivity(paused, true, new Date(2024, 2, 1));
  assert.deepEqual(computePendingRecurringExpenses([resumed], [], new Date(2024, 2, 31)).map(entry => entry.period), ["2024-03"]);
});

test("a pause does not change the start-month anchor of an interval spanning a year", () => {
  const paused = applyRecurringActivity(template({ startMonth: "2025-11", intervalMonths: 3 }), false, new Date(2025, 11, 1));
  const resumed = applyRecurringActivity(paused, true, new Date(2026, 3, 1));
  assert.deepEqual(computePendingRecurringExpenses([resumed], [{ id: "rec_subscription_2025-11" }], new Date(2026, 7, 1)).map(entry => entry.period), ["2026-05", "2026-08"]);
});

test("legacy paused templates with no pause date exclude past unposted bills upon resume", () => {
  const resumed = applyRecurringActivity(template({ active: false }), true, new Date(2026, 9, 5));
  assert.equal(resumed.skipBeforeDate, "2026-10-05");
  assert.deepEqual(computePendingRecurringExpenses([resumed], [], new Date(2026, 9, 5)), []);
  assert.deepEqual(computePendingRecurringExpenses([resumed], [], new Date(2026, 10, 1)).map(entry => entry.period), ["2026-11"]);
});

test("duplicate activity commands never move a pause date or append the same range twice", () => {
  const paused = applyRecurringActivity(template(), false, new Date(2026, 3, 1));
  assert.equal(applyRecurringActivity(paused, false, new Date(2026, 4, 1)), paused);
  const resumed = applyRecurringActivity(paused, true, new Date(2026, 9, 1));
  assert.equal(applyRecurringActivity(resumed, true, new Date(2026, 10, 1)), resumed);
  assert.equal(resumed.pausedRanges.length, 1);
});

test("new forms use the local current month and selected category", () => {
  assert.equal(createRecurringForm("cafe", new Date(2026, 9, 1, 0, 15)).startMonth, "2026-10");
  assert.equal(createRecurringForm("cafe").category, "cafe");
});

test("validates required fields, dates, amounts and supported intervals", () => {
  const item = template({ title: " サブスク ", amount: "1000" });
  assert.equal(normalizeRecurringForm(item).title, "サブスク");
  assert.equal(normalizeRecurringForm(item).amount, 1000);
  for (const overrides of [
    { title: " " }, { amount: "" }, { amount: 0 }, { amount: -1 }, { amount: Infinity },
    { amount: 1.5 }, { amount: Number.MAX_SAFE_INTEGER + 1 }, { category: "" },
    { startMonth: "" }, { startMonth: "2026-13" }, { startMonth: "0000-01" },
    { dayOfMonth: 0 }, { dayOfMonth: 32 }, { dayOfMonth: 1.5 }, { intervalMonths: 0 }, { intervalMonths: 5 },
  ]) {
    assert.equal(normalizeRecurringForm({ ...item, ...overrides }), null, JSON.stringify(overrides));
    assert.deepEqual(computePendingRecurringExpenses([{ ...item, ...overrides }], [], new Date(2026, 2, 1)), []);
  }
});

test("generated expenses preserve recurrence metadata and flag variable amounts", () => {
  const item = template({ amount: "2000", amountVaries: true });
  const generated = recurringExpenseToDoc({ item, period: "2026-03", dueDay: 1 });
  assert.deepEqual(generated, {
    title: "サブスク", amount: 2000, category: "other", memo: "共有", date: "2026-03-01",
    type: "expense", recurringId: item.id, recurringPeriod: "2026-03", needsConfirmation: true,
  });
  item.amount = 3000;
  assert.equal(generated.amount, 2000);
  assert.equal(recurringExpenseToDoc({ item: template(), period: "2026-03", dueDay: 1 }).needsConfirmation, false);
});

test("deleted periods stay deleted even when their expense date was edited", () => {
  const items = [template(), template({ id: "another" })];
  const expense = { id: "rec_subscription_2026-02", recurringId: items[0].id, recurringPeriod: "2026-02", date: "2026-03-05" };
  const updated = skipRecurringPeriod(items, expense);
  assert.deepEqual(updated[0].skippedPeriods, ["2026-02"]);
  assert.equal(updated[1], items[1]);
  assert.equal(items[0].skippedPeriods, undefined);
  assert.deepEqual(skipRecurringPeriod(updated, expense)[0].skippedPeriods, ["2026-02"]);
  assert.deepEqual(computePendingRecurringExpenses([updated[0]], [], new Date(2026, 2, 1)).map(entry => entry.period), ["2026-01", "2026-03"]);
});

test("duplicate template IDs cannot schedule the same expense twice", () => {
  const item = template({ startMonth: "2026-03" });
  assert.equal(computePendingRecurringExpenses([item, item], [], new Date(2026, 2, 1)).length, 1);
});

const transactionFor = (items, existingExpense) => ({
  writes: [],
  async get(ref) {
    const data = ref === "settings" ? { items } : existingExpense;
    return { exists: () => data !== undefined, data: () => data };
  },
  set(ref, data) { this.writes.push({ ref, data }); },
});

test("a stale candidate never overwrites a record already posted and edited by the other user", async () => {
  const item = template({ startMonth: "2026-03" });
  const today = new Date(2026, 2, 1);
  const [pending] = computePendingRecurringExpenses([item], [], today);
  const existing = { ...recurringExpenseToDoc(pending), amount: 1700, needsConfirmation: false };
  const transaction = transactionFor([item], existing);
  assert.equal(await postRecurringExpense(transaction, "settings", "expense", pending, today), false);
  assert.deepEqual(transaction.writes, []);
  assert.equal(existing.amount, 1700);
});

test("posting uses the current shared template instead of stale form values", async () => {
  const item = template({ startMonth: "2026-03" });
  const today = new Date(2026, 2, 1);
  const [pending] = computePendingRecurringExpenses([item], [], today);
  const transaction = transactionFor([{ ...item, amount: 2400, amountVaries: true }]);
  assert.equal(await postRecurringExpense(transaction, "settings", "expense", pending, today), true);
  assert.equal(transaction.writes[0].data.amount, 2400);
  assert.equal(transaction.writes[0].data.needsConfirmation, true);
});

test("a template paused, deleted, rescheduled or skipped during posting creates no expense", async () => {
  const item = template({ startMonth: "2026-03" });
  const today = new Date(2026, 2, 1);
  const [pending] = computePendingRecurringExpenses([item], [], today);
  for (const items of [[], [{ ...item, active: false }], [{ ...item, dayOfMonth: 15 }], [{ ...item, startMonth: "2026-04" }], [{ ...item, skippedPeriods: ["2026-03"] }],
    [{ ...item, pausedRanges: [{ from: "2026-03-01", until: "2026-03-02" }] }], [{ ...item, skipBeforeDate: "2026-03-02" }]]) {
    const transaction = transactionFor(items);
    assert.equal(await postRecurringExpense(transaction, "settings", "expense", pending, today), false);
    assert.deepEqual(transaction.writes, []);
  }
});
