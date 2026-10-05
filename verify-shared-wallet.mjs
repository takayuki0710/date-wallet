import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInAnonymously, signOut } from "firebase/auth";
import {
  getFirestore, connectFirestoreEmulator, doc, collection, getDoc, getDocs,
  setDoc, runTransaction, terminate, setLogLevel,
} from "firebase/firestore";
import { computePendingRecurringExpenses, postRecurringExpense, recurringExpenseToDoc } from "./src/recurringExpenses.js";
import {
  WalletError, saveExpense, confirmExpenseAmount, deleteExpenseRecord, saveRecurringTemplate,
  setRecurringActive, deleteRecurringTemplate, saveCategory, deleteCategory, moveCategory,
} from "./src/walletTransactions.js";

// このファイルは必ずエミュレーターだけに接続します。.env.localは読みません。
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!/^127\.0\.0\.1:\d+$/.test(firestoreHost || "") || !/^127\.0\.0\.1:\d+$/.test(authHost || "")) {
  throw new Error("npm run test:integrationでローカルエミュレーターを起動してください");
}
const projectId = "demo-date-wallet-test";
const today = new Date(2026, 9, 5);
const defaults = [
  { id: "food", label: "食事", emoji: "🍽", color: "#C4785A" },
  { id: "other", label: "その他", emoji: "✦", color: "#888888" },
  { id: "unused", label: "未使用", emoji: "✦", color: "#999999" },
];
const template = (overrides = {}) => ({
  id: "subscription", title: "サブスク", amount: 1000, category: "other", memo: "",
  startMonth: "2026-10", dayOfMonth: 1, intervalMonths: 1, active: true, amountVaries: false,
  ...overrides,
});
const candidate = item => computePendingRecurringExpenses([item], [], today)[0];
const clients = [];
const refs = (client, id = "record") => ({
  recurringRef: doc(client.db, "settings", "recurring"),
  categoriesRef: doc(client.db, "settings", "shared"),
  expenseRef: doc(client.db, "expenses", id), defaults,
});
const perform = (client, operation) => runTransaction(client.db, operation);
const post = (client, entry, transaction) => {
  const { recurringRef, categoriesRef, expenseRef } = refs(client, entry.expId);
  const operation = tx => postRecurringExpense(tx, recurringRef, expenseRef, entry, today, { categoriesRef, defaults });
  return transaction ? operation(transaction) : perform(client, operation);
};
const record = (item = template()) => ({ id: candidate(item).expId, ...recurringExpenseToDoc(candidate(item)) });
const seed = async (items = [template()], expenses = []) => {
  const { categoriesRef, recurringRef } = refs(clients[0]);
  await Promise.all([
    setDoc(categoriesRef, { categories: defaults, expenseRevision: 0 }),
    setDoc(recurringRef, { items }),
    ...expenses.map(({ id, ...data }) => setDoc(doc(clients[0].db, "expenses", id), data)),
  ]);
};
const stored = async (ref) => (await getDoc(ref)).data();
const expenses = async () => (await getDocs(collection(clients[0].db, "expenses"))).docs.map(document => ({ id: document.id, ...document.data() }));
const latch = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};

// 最初の試行を同じ読み取り状態で待ち合わせ、競合による再試行を実際に起こします。
const collide = async operations => {
  const ready = latch();
  let waiting = 0;
  const attempts = operations.map(() => 0);
  const results = await Promise.allSettled(operations.map((operation, index) => perform(clients[index], async transaction => {
    attempts[index]++;
    const result = await operation(transaction, clients[index]);
    if (attempts[index] === 1) {
      if (++waiting === operations.length) ready.release();
      await ready.promise;
    }
    return result;
  })));
  assert.ok(attempts.reduce((total, count) => total + count, 0) >= operations.length + 1, "実際の競合による再試行を確認");
  return results;
};

before(async () => {
  setLogLevel("silent");
  for (const name of ["member-a", "member-b"]) {
    const app = initializeApp({ projectId, apiKey: "emulator-only-key", authDomain: `${projectId}.firebaseapp.com` }, name);
    const auth = getAuth(app);
    connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
    await signInAnonymously(auth);
    const db = getFirestore(app);
    const [host, port] = firestoreHost.split(":");
    connectFirestoreEmulator(db, host, Number(port));
    clients.push({ app, auth, db });
  }
  assert.notEqual(clients[0].auth.currentUser.uid, clients[1].auth.currentUser.uid);
});
beforeEach(async () => {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true);
});
after(async () => {
  await Promise.all(clients.map(async client => { await signOut(client.auth); await terminate(client.db); await deleteApp(client.app); }));
});

test("two authenticated members posting the same period create exactly one expense", { timeout: 45000 }, async () => {
  const entry = candidate(template());
  await seed();
  const results = await collide([tx => post(clients[0], entry, tx), tx => post(clients[1], entry, tx)]);
  assert.ok(results.every(result => result.status === "fulfilled"));
  assert.equal(results.filter(result => result.value === true).length, 1);
  assert.equal((await expenses()).length, 1);
});

test("both members filling several missed months still create only one record per month", { timeout: 45000 }, async () => {
  const item = template({ startMonth: "2026-08" });
  await seed([item]);
  const pending = computePendingRecurringExpenses([item], [], today);
  await Promise.all(clients.map(async client => { for (const entry of pending) await post(client, entry); }));
  assert.deepEqual((await expenses()).map(expense => expense.recurringPeriod).sort(), ["2026-08", "2026-09", "2026-10"]);
});

test("an empty or delayed expense snapshot does not overwrite the other member's edited amount", async () => {
  const item = template();
  await seed([item], [{ ...record(item), amount: 2500, needsConfirmation: false }]);
  assert.equal(await post(clients[1], candidate(item)), false);
  assert.equal((await expenses())[0].amount, 2500);
});

test("two simultaneous pause commands leave the template paused", { timeout: 45000 }, async () => {
  await seed();
  const results = await collide(clients.map(client => tx => setRecurringActive(tx, refs(client).recurringRef, "subscription", false)));
  assert.ok(results.every(result => result.status === "fulfilled"));
  assert.equal((await stored(refs(clients[0]).recurringRef)).items[0].active, false);
  assert.equal(await post(clients[1], candidate(template())), false);
});

test("a six-month subscription cancellation never posts the cancelled months after resuming", { timeout: 45000 }, async () => {
  const item = template({ startMonth: "2026-03" });
  await seed([item], [record(item)]);
  await perform(clients[0], tx => setRecurringActive(tx, refs(clients[0]).recurringRef, item.id, false, new Date(2026, 3, 1)));
  await perform(clients[1], tx => setRecurringActive(tx, refs(clients[1]).recurringRef, item.id, true, new Date(2026, 9, 1)));
  const resumed = (await stored(refs(clients[0]).recurringRef)).items[0];
  assert.deepEqual(resumed.pausedRanges, [{ from: "2026-04-01", until: "2026-10-01" }]);
  const pending = computePendingRecurringExpenses([resumed], await expenses(), today);
  assert.deepEqual(pending.map(entry => entry.period), ["2026-10"]);
  // 古い画面が休止中の月を候補にしていても、最新の共有設定で除外します。
  for (const entry of computePendingRecurringExpenses([item], await expenses(), today).filter(entry => entry.period < "2026-10")) {
    assert.equal(await post(clients[1], entry), false);
  }
  const results = await collide(clients.map(client => tx => post(client, pending[0], tx)));
  assert.ok(results.every(result => result.status === "fulfilled"));
  assert.deepEqual((await expenses()).map(expense => expense.recurringPeriod).sort(), ["2026-03", "2026-10"]);
});

test("two simultaneous resumes close one shared pause range exactly once", { timeout: 45000 }, async () => {
  await seed([template({ active: false, pausedAt: "2026-04-01", skippedPeriods: ["2026-03"] })]);
  const results = await collide(clients.map(client => tx => setRecurringActive(tx, refs(client).recurringRef, "subscription", true, new Date(2026, 9, 1))));
  assert.ok(results.every(result => result.status === "fulfilled"));
  assert.equal(results.filter(result => result.value === true).length, 1);
  const resumed = (await stored(refs(clients[0]).recurringRef)).items[0];
  assert.equal(resumed.active, true);
  assert.equal(resumed.pausedAt, undefined);
  assert.deepEqual(resumed.pausedRanges, [{ from: "2026-04-01", until: "2026-10-01" }]);
  assert.deepEqual(resumed.skippedPeriods, ["2026-03"]);
});

test("editing the template to pause and resume uses the same period exclusion as the switch", async () => {
  const item = template({ startMonth: "2026-03" });
  await seed([item], [record(item)]);
  const save = (client, expected, changes, date) => perform(client, tx => saveRecurringTemplate(tx, {
    ...refs(client), id: item.id, expected, form: { ...expected, ...changes }, today: date,
  }));
  await save(clients[0], item, { active: false }, new Date(2026, 3, 1));
  const paused = (await stored(refs(clients[0]).recurringRef)).items[0];
  assert.equal(paused.pausedAt, "2026-04-01");
  await save(clients[1], paused, { memo: "休止中の編集" }, new Date(2026, 6, 1));
  const edited = (await stored(refs(clients[0]).recurringRef)).items[0];
  assert.equal(edited.pausedAt, "2026-04-01");
  await save(clients[0], edited, { active: true }, new Date(2026, 9, 1));
  const resumed = (await stored(refs(clients[0]).recurringRef)).items[0];
  assert.equal(resumed.memo, "休止中の編集");
  assert.deepEqual(computePendingRecurringExpenses([resumed], await expenses(), today).map(entry => entry.period), ["2026-10"]);
});

test("legacy paused settings resume without creating any past unposted expense", async () => {
  const item = template({ startMonth: "2026-03", active: false });
  await seed([item]);
  await perform(clients[0], tx => setRecurringActive(tx, refs(clients[0]).recurringRef, item.id, true, today));
  const resumed = (await stored(refs(clients[1]).recurringRef)).items[0];
  assert.deepEqual(computePendingRecurringExpenses([resumed], [], today), []);
  assert.deepEqual(computePendingRecurringExpenses([resumed], [], new Date(2026, 10, 1)).map(entry => entry.period), ["2026-11"]);
  const stale = candidate({ ...item, active: true });
  assert.equal(await post(clients[1], stale), false);
});

test("a new template created OFF remains unbillable until its first resume", async () => {
  await seed([]);
  const form = template({ startMonth: "2026-03", active: false });
  await perform(clients[0], tx => saveRecurringTemplate(tx, { ...refs(clients[0]), id: form.id, expected: null, form, today }));
  await perform(clients[1], tx => setRecurringActive(tx, refs(clients[1]).recurringRef, form.id, true, new Date(2026, 9, 1)));
  const resumed = (await stored(refs(clients[0]).recurringRef)).items[0];
  assert.deepEqual(computePendingRecurringExpenses([resumed], [], today).map(entry => entry.period), ["2026-10"]);
});

test("a form opened before a pause cannot silently reactivate the template", async () => {
  const item = template();
  await seed();
  await perform(clients[0], tx => setRecurringActive(tx, refs(clients[0]).recurringRef, item.id, false));
  await assert.rejects(perform(clients[1], tx => saveRecurringTemplate(tx, { ...refs(clients[1]), id: item.id, form: { ...item, amount: 1500 }, expected: item })), WalletError);
  assert.equal((await stored(refs(clients[0]).recurringRef)).items[0].active, false);
});

test("concurrent edits to different recurring templates preserve both changes", { timeout: 45000 }, async () => {
  const items = [template({ id: "a" }), template({ id: "b" })];
  await seed(items);
  const results = await collide(items.map((item, index) => tx => saveRecurringTemplate(tx, { ...refs(clients[index]), id: item.id, form: { ...item, amount: 2000 + index }, expected: item })));
  assert.ok(results.every(result => result.status === "fulfilled"));
  assert.deepEqual((await stored(refs(clients[0]).recurringRef)).items.map(item => item.amount), [2000, 2001]);
});

test("concurrent edits to the same template report a conflict instead of silently losing a change", { timeout: 45000 }, async () => {
  const item = template();
  await seed();
  const results = await collide(clients.map((client, index) => tx => saveRecurringTemplate(tx, { ...refs(client), id: item.id, form: { ...item, amount: 2100 + index }, expected: item })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected");
  assert.ok(rejected.reason instanceof WalletError);
});

test("simultaneous template additions preserve both UUID records", { timeout: 45000 }, async () => {
  await seed([]);
  const ids = clients.map(() => `rec_${crypto.randomUUID()}`);
  const results = await collide(clients.map((client, index) => tx => saveRecurringTemplate(tx, { ...refs(client), id: ids[index], form: template(), expected: null })));
  assert.ok(results.every(result => result.status === "fulfilled"));
  assert.deepEqual((await stored(refs(clients[0]).recurringRef)).items.map(item => item.id).sort(), ids.sort());
});

test("manual expenses created at the same time do not collide", { timeout: 45000 }, async () => {
  await seed([]);
  const ids = clients.map(() => `exp_${crypto.randomUUID()}`);
  const form = { title: "手動", amount: 100, type: "expense", category: "food", date: "2026-10-05", memo: "" };
  const results = await collide(clients.map((client, index) => tx => saveExpense(tx, { ...refs(client, ids[index]), form, expected: null })));
  assert.ok(results.every(result => result.status === "fulfilled"));
  assert.equal((await expenses()).length, 2);
});

test("a stale edit cannot resurrect a recurring expense deleted by the other member", async () => {
  const original = record();
  await seed([template()], [original]);
  await perform(clients[0], tx => deleteExpenseRecord(tx, { ...refs(clients[0], original.id), expected: original }));
  await assert.rejects(perform(clients[1], tx => saveExpense(tx, { ...refs(clients[1], original.id), form: { ...original, amount: 1300 }, expected: original })), WalletError);
  assert.equal(await post(clients[1], candidate(template())), false);
  assert.equal((await expenses()).length, 0);
});

test("concurrent edits to one expense report the stale editor and preserve recurrence metadata", { timeout: 45000 }, async () => {
  const original = record();
  await seed([template()], [original]);
  const results = await collide(clients.map((client, index) => tx => saveExpense(tx, { ...refs(client, original.id), form: { title: original.title, amount: 1800 + index, type: "expense", category: original.category, date: original.date, memo: "" }, expected: original })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.ok(results.find(result => result.status === "rejected").reason instanceof WalletError);
  const saved = (await expenses())[0];
  assert.equal(saved.recurringId, original.recurringId);
  assert.equal(saved.recurringPeriod, original.recurringPeriod);
});

test("an old confirmation does not approve an amount changed by the other member", async () => {
  const original = record(template({ amountVaries: true }));
  await seed([template({ amountVaries: true })], [original]);
  await perform(clients[0], tx => saveExpense(tx, { ...refs(clients[0], original.id), form: { title: original.title, amount: 2200, type: "expense", category: original.category, date: original.date, memo: "" }, expected: original }));
  await assert.rejects(perform(clients[1], tx => confirmExpenseAmount(tx, refs(clients[1], original.id).expenseRef, original)), WalletError);
  assert.equal((await expenses())[0].amount, 2200);
});

test("editing a template preserves periods concurrently skipped by deleting an expense", async () => {
  const item = template();
  const original = record(item);
  await seed([item], [original]);
  await perform(clients[0], tx => deleteExpenseRecord(tx, { ...refs(clients[0], original.id), expected: original }));
  await perform(clients[1], tx => saveRecurringTemplate(tx, { ...refs(clients[1]), id: item.id, form: { ...item, amount: 1400 }, expected: item }));
  const updated = (await stored(refs(clients[0]).recurringRef)).items[0];
  assert.deepEqual(updated.skippedPeriods, ["2026-10"]);
  assert.equal(updated.amount, 1400);
  assert.equal(await post(clients[0], candidate(item)), false);
});

test("deleting a recurring template keeps posted expenses and blocks stale future posting", async () => {
  const item = template();
  await seed([item], [record(item)]);
  await perform(clients[0], tx => deleteRecurringTemplate(tx, refs(clients[0]).recurringRef, item));
  assert.equal((await expenses()).length, 1);
  const future = computePendingRecurringExpenses([item], [], new Date(2026, 10, 5))[1];
  const { recurringRef, categoriesRef, expenseRef } = refs(clients[1], future.expId);
  assert.equal(await perform(clients[1], tx => postRecurringExpense(tx, recurringRef, expenseRef, future, new Date(2026, 10, 5), { categoriesRef, defaults })), false);
});

test("concurrent category edits preserve unrelated categories and the revision marker", { timeout: 45000 }, async () => {
  await seed([]);
  const results = await collide(clients.map((client, index) => tx => saveCategory(tx, { ...refs(client), id: defaults[index].id, form: { ...defaults[index], label: `変更${index}` }, expected: defaults[index] })));
  assert.ok(results.every(result => result.status === "fulfilled"));
  const settings = await stored(refs(clients[0]).categoriesRef);
  assert.deepEqual(settings.categories.map(category => category.label), ["変更0", "変更1", "未使用"]);
  assert.equal(settings.expenseRevision, 0);
});

test("category deletion retries when another member creates an expense during its usage check", { timeout: 45000 }, async () => {
  await seed([]);
  const queried = latch();
  const release = latch();
  let checks = 0;
  const deletion = perform(clients[1], tx => deleteCategory(tx, {
    ...refs(clients[1]), id: "unused",
    loadExpenses: async () => {
      const snapshot = await expenses();
      if (++checks === 1) { queried.release(); await release.promise; }
      return snapshot;
    },
  }));
  // 先にcatchを登録して、再試行時の想定した拒否を未処理にしません。
  const outcome = assert.rejects(deletion, WalletError);
  await queried.promise;
  await perform(clients[0], tx => saveExpense(tx, {
    ...refs(clients[0], "new-during-check"), expected: null,
    form: { title: "同時追加", amount: 100, category: "unused", type: "expense", date: "2026-10-05" },
  }));
  release.release();
  await outcome;
  assert.ok(checks >= 2);
  assert.ok((await stored(refs(clients[0]).categoriesRef)).categories.some(category => category.id === "unused"));
});

test("a deleted category cannot receive a new expense or new recurring template", async () => {
  await seed([]);
  await perform(clients[0], tx => deleteCategory(tx, { ...refs(clients[0]), id: "unused", loadExpenses: expenses }));
  await assert.rejects(perform(clients[1], tx => saveExpense(tx, { ...refs(clients[1], "invalid-category"), expected: null, form: { title: "test", amount: 100, type: "expense", category: "unused", date: "2026-10-05" } })), WalletError);
  await assert.rejects(perform(clients[1], tx => saveRecurringTemplate(tx, { ...refs(clients[1]), id: "invalid-template", expected: null, form: template({ category: "unused" }) })), WalletError);
  assert.equal((await expenses()).length, 0);
});

test("a dragged category moves before or after its drop target without dropping items", async () => {
  await seed([]);
  const client = clients[0];
  const move = (id, anchorId, side) => perform(client, tx => moveCategory(tx, { ...refs(client), id, anchorId, side }));
  assert.equal(await move("food", "food", "before"), false);
  assert.equal(await move("unused", "unused", "after"), false);
  await move("unused", "other", "before");
  assert.deepEqual((await stored(refs(client).categoriesRef)).categories.map(category => category.id), ["food", "unused", "other"]);
  await move("unused", "food", "before");
  await move("unused", "food", "after");
  assert.deepEqual((await stored(refs(client).categoriesRef)).categories.map(category => category.id), ["food", "unused", "other"]);
});

test("concurrent moves compose without duplicating or losing categories", { timeout: 45000 }, async () => {
  await seed([]);
  const results = await collide(clients.map((client, index) => tx => moveCategory(tx, { ...refs(client), id: ["other", "unused"][index], anchorId: "food", side: "before" })));
  assert.ok(results.every(result => result.status === "fulfilled"));
  const ids = (await stored(refs(clients[0]).categoriesRef)).categories.map(category => category.id);
  assert.deepEqual(ids.slice(0, 2).sort(), ["other", "unused"]);
  assert.equal(ids[2], "food");
});

test("a category edit and a reorder preserve both the new label and the chosen order", { timeout: 45000 }, async () => {
  await seed([]);
  const results = await collide([
    tx => moveCategory(tx, { ...refs(clients[0]), id: "other", anchorId: "food", side: "before" }),
    tx => saveCategory(tx, { ...refs(clients[1]), id: "other", expected: defaults[1], form: { ...defaults[1], label: "よく使う" } }),
  ]);
  assert.ok(results.every(result => result.status === "fulfilled"));
  const categories = (await stored(refs(clients[0]).categoriesRef)).categories;
  assert.equal(categories[0].id, "other");
  assert.equal(categories[0].label, "よく使う");
});

test("a new category added at the front survives a simultaneous reorder", { timeout: 45000 }, async () => {
  await seed([]);
  const results = await collide([
    tx => moveCategory(tx, { ...refs(clients[0]), id: "unused", anchorId: "other", side: "before" }),
    tx => saveCategory(tx, { ...refs(clients[1]), id: "new", expected: null, position: "first", form: { label: "新規", emoji: "✦", color: "#999" } }),
  ]);
  assert.ok(results.every(result => result.status === "fulfilled"));
  const categories = (await stored(refs(clients[0]).categoriesRef)).categories;
  assert.equal(categories[0].id, "new");
  assert.deepEqual(categories.map(category => category.id).sort(), ["food", "new", "other", "unused"]);
  await perform(clients[0], tx => saveCategory(tx, { ...refs(clients[0]), id: "last", expected: null, position: "last", form: { label: "末尾", emoji: "✦", color: "#999" } }));
  assert.equal((await stored(refs(clients[0]).categoriesRef)).categories.at(-1).id, "last");
});

test("a drag whose target or category was deleted refuses without moving another item", async () => {
  await seed([]);
  const client = clients[0];
  const remove = id => perform(client, tx => deleteCategory(tx, { ...refs(client), id, loadExpenses: async () => [] }));
  const move = (id, anchorId) => perform(clients[1], tx => moveCategory(tx, { ...refs(clients[1]), id, anchorId, side: "before" }));
  await remove("unused");
  await assert.rejects(move("food", "unused"), WalletError);
  await assert.rejects(move("unused", "food"), WalletError);
  assert.deepEqual((await stored(refs(client).categoriesRef)).categories.map(category => category.id), ["food", "other"]);
});
