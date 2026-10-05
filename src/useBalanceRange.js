import { useEffect, useState } from "react";
import {
  balanceRangeKey, browserStorage, isBalanceRange, readBalanceRange, writeBalanceRange,
} from "./chartPreferences.js";

export const useBalanceRange = (projectId, userId) => {
  const key = balanceRangeKey(projectId, userId);
  const [selection, setSelection] = useState(() => ({ key, value: readBalanceRange(browserStorage(), key) }));
  // アカウント変更の最初の描画から、新しいユーザーの選択を使います。
  const value = selection.key === key ? selection.value : readBalanceRange(browserStorage(), key);

  useEffect(() => {
    setSelection({ key, value: readBalanceRange(browserStorage(), key) });
    const onStorage = event => {
      if (event.key === key || event.key === null) {
        setSelection({ key, value: readBalanceRange(browserStorage(), key) });
      }
    };
    globalThis.addEventListener?.("storage", onStorage);
    return () => globalThis.removeEventListener?.("storage", onStorage);
  }, [key]);

  const select = next => {
    if (!key || !isBalanceRange(next)) return;
    // 初回描画を保存しないことで、他ユーザーの値で上書きすることを防ぎます。
    writeBalanceRange(browserStorage(), key, next);
    setSelection({ key, value: next });
  };
  return [value, select];
};
