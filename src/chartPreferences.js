export const BALANCE_RANGES = [
  { id: "1m", label: "1ヶ月", months: 1 },
  { id: "3m", label: "3ヶ月", months: 3 },
  { id: "6m", label: "6ヶ月", months: 6 },
  { id: "1y", label: "1年", months: 12 },
  { id: "all", label: "全期間", months: null },
];
export const DEFAULT_BALANCE_RANGE = "3m";
export const isBalanceRange = value => BALANCE_RANGES.some(range => range.id === value);
export const balanceRangeKey = (projectId, userId) => userId
  ? `date-wallet:${encodeURIComponent(projectId || "default")}:balance-range:${encodeURIComponent(userId)}`
  : null;

export const readBalanceRange = (storage, key) => {
  try {
    const value = key ? storage?.getItem(key) : null;
    return isBalanceRange(value) ? value : DEFAULT_BALANCE_RANGE;
  } catch {
    return DEFAULT_BALANCE_RANGE;
  }
};

export const writeBalanceRange = (storage, key, value) => {
  if (!key || !isBalanceRange(value)) return false;
  try {
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    // 保存が禁止されているブラウザーでも、画面内での選択は使えます。
    return false;
  }
};

export const browserStorage = () => {
  try { return globalThis.localStorage; } catch { return undefined; }
};
