const pad2 = (value) => String(value).padStart(2, "0");
const monthKey = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
const dateKey = (date) => `${monthKey(date)}-${pad2(date.getDate())}`;
const isDateKey = value => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value);

// 休止期間は開始日を含み、再開日は含みません。再開日の計上は対象にします。
export const applyRecurringActivity = (item, active, today = new Date()) => {
  if (!!item.active === active) return item;
  const changedOn = dateKey(today);
  if (!active) return { ...item, active: false, pausedAt: changedOn };
  const { pausedAt, ...resumed } = item;
  if (isDateKey(pausedAt)) {
    const pausedRanges = Array.isArray(item.pausedRanges) ? item.pausedRanges : [];
    return { ...resumed, active: true, pausedRanges: pausedAt < changedOn
      ? [...pausedRanges, { from: pausedAt, until: changedOn }] : pausedRanges };
  }
  // 旧版で休止した設定は休止日が不明なため、再開日より前の未計上分を除外します。
  return { ...resumed, active: true, skipBeforeDate: isDateKey(item.skipBeforeDate) && item.skipBeforeDate > changedOn
    ? item.skipBeforeDate : changedOn };
};

export const INTERVAL_OPTIONS = [
  { value: 1, label: "毎月" },
  { value: 2, label: "隔月（2ヶ月ごと）" },
  { value: 3, label: "3ヶ月ごと" },
  { value: 6, label: "半年ごと" },
  { value: 12, label: "年1回" },
];

export const createRecurringForm = (category = "food", today = new Date()) => ({
  title: "", amount: "", category, dayOfMonth: 1, intervalMonths: 1,
  startMonth: monthKey(today), memo: "", active: true, amountVaries: false,
});

export const normalizeRecurringForm = (form) => {
  const amount = Number(form.amount);
  const dayOfMonth = Number(form.dayOfMonth);
  const intervalMonths = Number(form.intervalMonths);
  if (!form.title?.trim() || !Number.isSafeInteger(amount) || amount <= 0
    || !form.category || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(form.startMonth)
    || !Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31
    || !INTERVAL_OPTIONS.some(option => option.value === intervalMonths)) return null;

  return {
    title: form.title.trim(), amount, category: form.category,
    dayOfMonth, intervalMonths, startMonth: form.startMonth,
    memo: form.memo || "", active: !!form.active, amountVaries: !!form.amountVaries,
  };
};

// 有効だった期間の未計上分だけを補い、休止中に到来した計上日は除外します。
export const computePendingRecurringExpenses = (recurringItems, expenses, todayInput = new Date()) => {
  const today = new Date(todayInput);
  today.setHours(0, 0, 0, 0);
  const currentMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const existingIds = new Set(expenses.map(expense => expense.id));
  const pending = [];

  for (const item of recurringItems) {
    if (!item.active || !item.id || !normalizeRecurringForm(item)) continue;
    const start = new Date(`${item.startMonth}-01T00:00:00`);
    const skippedPeriods = new Set(item.skippedPeriods || []);
    const pausedRanges = (Array.isArray(item.pausedRanges) ? item.pausedRanges : [])
      .filter(range => range && isDateKey(range.from) && isDateKey(range.until) && range.from < range.until);
    for (let date = new Date(start); date <= currentMonth;
      date = new Date(date.getFullYear(), date.getMonth() + Number(item.intervalMonths), 1)) {
      const period = monthKey(date);
      const dueDay = Math.min(Number(item.dayOfMonth), new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate());
      const dueDate = new Date(date.getFullYear(), date.getMonth(), dueDay);
      const dueDateKey = dateKey(dueDate);
      const expId = `rec_${item.id}_${period}`;
      const wasPaused = pausedRanges.some(range => range.from <= dueDateKey && dueDateKey < range.until);
      const beforeLegacyResume = isDateKey(item.skipBeforeDate) && dueDateKey < item.skipBeforeDate;
      if (dueDate <= today && !existingIds.has(expId) && !skippedPeriods.has(period) && !wasPaused && !beforeLegacyResume) {
        pending.push({ item, period, dueDay, expId });
        existingIds.add(expId);
      }
    }
  }
  return pending;
};

export const recurringExpenseToDoc = ({ item, period, dueDay }) => ({
  title: item.title, amount: Number(item.amount), category: item.category,
  memo: item.memo || "", date: `${period}-${pad2(dueDay)}`, type: "expense",
  recurringId: item.id, recurringPeriod: period, needsConfirmation: !!item.amountVaries,
});

// 共有相手が先に計上・編集した記録を上書きせず、最新の定期設定を使います。
export const postRecurringExpense = async (transaction, settingsRef, expenseRef, pending, today = new Date(), categoryContext) => {
  const [settings, expense, categories] = await Promise.all([
    transaction.get(settingsRef), transaction.get(expenseRef),
    categoryContext ? transaction.get(categoryContext.categoriesRef) : undefined,
  ]);
  if (expense.exists()) return false;
  const item = settings.data()?.items?.find(entry => entry.id === pending.item.id);
  if (!item) return false;
  const current = computePendingRecurringExpenses([item], [], today)
    .find(entry => entry.period === pending.period);
  if (!current) return false;
  if (categoryContext && !(categories.data()?.categories || categoryContext.defaults).some(category => category.id === item.category)) return false;
  transaction.set(expenseRef, recurringExpenseToDoc(current));
  if (categoryContext) {
    transaction.set(categoryContext.categoriesRef, { expenseRevision: (Number(categories.data()?.expenseRevision) || 0) + 1 }, { merge: true });
  }
  return true;
};

// 削除した月の記録は、次回起動時にも自動で作り直しません。
export const skipRecurringPeriod = (items, expense) => {
  const period = expense.recurringPeriod || expense.id?.slice(-7);
  if (!expense.recurringId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return items;
  return items.map(item => item.id === expense.recurringId
    ? { ...item, skippedPeriods: [...new Set([...(item.skippedPeriods || []), period])] }
    : item);
};
