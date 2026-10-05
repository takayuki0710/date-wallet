import { applyRecurringActivity, normalizeRecurringForm, skipRecurringPeriod } from "./recurringExpenses.js";
import { placeCategory } from "./categoryOrder.js";

export class WalletError extends Error {}
const changedMessage = "別のユーザーが更新しました。画面を開き直してください";
const missingMessage = "この項目は既に削除されています";
const expenseFields = ["title", "amount", "category", "memo", "date", "type", "needsConfirmation"];
const recurringFields = ["title", "amount", "category", "memo", "dayOfMonth", "intervalMonths", "startMonth", "active", "amountVaries"];
const canonicalExpense = value => ({ ...value, type: value.type || "expense", memo: value.memo || "", needsConfirmation: !!value.needsConfirmation });
const assertUnchanged = (current, expected, fields) => {
  if (!expected || fields.some(field => current[field] !== expected[field])) throw new WalletError(changedMessage);
};
const categoriesOf = (snapshot, defaults) => snapshot.data()?.categories || defaults;
const assertCategory = (categories, category) => {
  if (!categories.some(item => item.id === category)) throw new WalletError("カテゴリが変更されています。画面を開き直してください");
};
export const expenseRevisionData = snapshot => ({ expenseRevision: (Number(snapshot.data()?.expenseRevision) || 0) + 1 });

export const saveExpense = async (transaction, { expenseRef, categoriesRef, form, expected, defaults }) => {
  const [expense, settings] = await Promise.all([transaction.get(expenseRef), transaction.get(categoriesRef)]);
  if (expected) {
    if (!expense.exists()) throw new WalletError(missingMessage);
    assertUnchanged(canonicalExpense(expense.data()), canonicalExpense(expected), expenseFields);
  } else if (expense.exists()) throw new WalletError(changedMessage);
  if (form.type !== "income") assertCategory(categoriesOf(settings, defaults), form.category);
  const data = {
    title: form.title, amount: form.amount, category: form.category,
    memo: form.memo || "", date: form.date, type: form.type || "expense", needsConfirmation: false,
  };
  if (expected) transaction.update(expenseRef, data);
  else transaction.set(expenseRef, data);
  transaction.set(categoriesRef, expenseRevisionData(settings), { merge: true });
};

export const confirmExpenseAmount = async (transaction, expenseRef, expected) => {
  const expense = await transaction.get(expenseRef);
  if (!expense.exists()) throw new WalletError(missingMessage);
  assertUnchanged(canonicalExpense(expense.data()), canonicalExpense(expected), expenseFields);
  transaction.update(expenseRef, { needsConfirmation: false });
};

export const deleteExpenseRecord = async (transaction, { expenseRef, recurringRef, categoriesRef, expected }) => {
  const [expense, recurring, settings] = await Promise.all([
    transaction.get(expenseRef), transaction.get(recurringRef), transaction.get(categoriesRef),
  ]);
  if (!expense.exists()) return false;
  const current = { ...expense.data(), id: expenseRef.id };
  assertUnchanged(canonicalExpense(current), canonicalExpense(expected), expenseFields);
  if (current.recurringId && recurring.exists()) {
    transaction.set(recurringRef, { items: skipRecurringPeriod(recurring.data().items || [], current) }, { merge: true });
  }
  transaction.delete(expenseRef);
  transaction.set(categoriesRef, expenseRevisionData(settings), { merge: true });
  return true;
};

export const saveRecurringTemplate = async (transaction, { recurringRef, categoriesRef, id, form, expected, defaults, today = new Date() }) => {
  const [recurring, settings] = await Promise.all([transaction.get(recurringRef), transaction.get(categoriesRef)]);
  const items = recurring.data()?.items || [];
  const data = normalizeRecurringForm(form);
  if (!data) throw new WalletError("定期支出の入力内容を確認してください");
  assertCategory(categoriesOf(settings, defaults), data.category);
  const current = items.find(item => item.id === id);
  if (expected) {
    if (!current) throw new WalletError(missingMessage);
    assertUnchanged(normalizeRecurringForm(current) || {}, normalizeRecurringForm(expected) || {}, recurringFields);
  } else if (current) throw new WalletError(changedMessage);
  const next = expected ? items.map(item => item.id === id ? { ...applyRecurringActivity(item, data.active, today), ...data } : item)
    : [...items, { id, ...data, ...(!data.active ? { pausedAt: `${data.startMonth}-01` } : {}) }];
  transaction.set(recurringRef, { items: next }, { merge: true });
};

export const setRecurringActive = async (transaction, recurringRef, id, active, today = new Date()) => {
  const recurring = await transaction.get(recurringRef);
  const items = recurring.data()?.items || [];
  const current = items.find(item => item.id === id);
  if (!current) throw new WalletError(missingMessage);
  if (!!current.active === active) return false;
  // 二人が同時にOFFにしても、反転を二回行ってONに戻してしまいません。
  transaction.set(recurringRef, { items: items.map(item => item.id === id ? applyRecurringActivity(item, active, today) : item) }, { merge: true });
  return true;
};

export const deleteRecurringTemplate = async (transaction, recurringRef, expected) => {
  const recurring = await transaction.get(recurringRef);
  const items = recurring.data()?.items || [];
  const current = items.find(item => item.id === expected.id);
  if (!current) return false;
  assertUnchanged(normalizeRecurringForm(current) || {}, normalizeRecurringForm(expected) || {}, recurringFields);
  transaction.set(recurringRef, { items: items.filter(item => item.id !== expected.id) }, { merge: true });
  return true;
};

export const saveCategory = async (transaction, { categoriesRef, id, form, expected, defaults, position = "last" }) => {
  const settings = await transaction.get(categoriesRef);
  const categories = categoriesOf(settings, defaults);
  const current = categories.find(category => category.id === id);
  if (expected) {
    if (!current) throw new WalletError(missingMessage);
    assertUnchanged(current, expected, ["label", "emoji", "color"]);
  } else if (current) throw new WalletError(changedMessage);
  const added = { id, ...form };
  const next = expected ? categories.map(category => category.id === id ? { ...category, ...form } : category)
    : position === "first" ? [added, ...categories] : [...categories, added];
  transaction.set(categoriesRef, { categories: next }, { merge: true });
};

export const moveCategory = async (transaction, { categoriesRef, id, anchorId, side, defaults }) => {
  const settings = await transaction.get(categoriesRef);
  const categories = categoriesOf(settings, defaults);
  const next = placeCategory(categories, { id, anchorId, side });
  if (!next) throw new WalletError("移動するカテゴリが変更されました。もう一度並べ替えてください");
  if (next.every((category, index) => category.id === categories[index].id)) return false;
  transaction.set(categoriesRef, { categories: next }, { merge: true });
  return true;
};

export const deleteCategory = async (transaction, { categoriesRef, recurringRef, id, loadExpenses, defaults }) => {
  const [settings, recurring] = await Promise.all([transaction.get(categoriesRef), transaction.get(recurringRef)]);
  const categories = categoriesOf(settings, defaults);
  if (!categories.some(category => category.id === id)) return false;
  if ((recurring.data()?.items || []).some(item => item.category === id) || (await loadExpenses()).some(expense => expense.category === id)) {
    throw new WalletError("使用中のカテゴリは削除できません");
  }
  if (categories.length <= 1) throw new WalletError("カテゴリは1件以上必要です");
  // カテゴリの利用状況が変わる記録更新は同じ設定のexpenseRevisionを更新するため、上の取得中に
  // 別の記録が追加・変更された場合はトランザクションが再試行されます。
  transaction.set(categoriesRef, { categories: categories.filter(category => category.id !== id) }, { merge: true });
  return true;
};
