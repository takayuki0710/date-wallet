import test from "node:test";
import assert from "node:assert/strict";
import {
  createRecurringForm, normalizeRecurringForm, computePendingRecurringExpenses,
  recurringExpenseToDoc, postRecurringExpense, skipRecurringPeriod,
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

test("resuming a paused template fills due missing months", () => {
  const item = template({ active: false });
  const existing = [{ id: "rec_subscription_2026-01" }];
  assert.deepEqual(computePendingRecurringExpenses([item], existing, new Date(2026, 2, 1)), []);
  assert.deepEqual(computePendingRecurringExpenses([{ ...item, active: true }], existing, new Date(2026, 2, 1)).map(entry => entry.period), ["2026-02", "2026-03"]);
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
  for (const items of [[], [{ ...item, active: false }], [{ ...item, dayOfMonth: 15 }], [{ ...item, startMonth: "2026-04" }], [{ ...item, skippedPeriods: ["2026-03"] }]]) {
    const transaction = transactionFor(items);
    assert.equal(await postRecurringExpense(transaction, "settings", "expense", pending, today), false);
    assert.deepEqual(transaction.writes, []);
  }
});
