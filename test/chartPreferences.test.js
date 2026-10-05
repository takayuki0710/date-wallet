import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  BALANCE_RANGES, balanceRangeKey, readBalanceRange, writeBalanceRange,
} from "../src/chartPreferences.js";
import { useBalanceRange } from "../src/useBalanceRange.js";

const storage = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test("all five ranges persist across reopening the same user's view", () => {
  const cache = storage();
  const key = balanceRangeKey("wallet", "user-a");
  for (const range of BALANCE_RANGES) {
    assert.equal(writeBalanceRange(cache, key, range.id), true);
    assert.equal(readBalanceRange(cache, key), range.id);
  }
});

test("users and Firebase projects do not share a preference key", () => {
  const cache = storage();
  writeBalanceRange(cache, balanceRangeKey("wallet", "user-a"), "all");
  writeBalanceRange(cache, balanceRangeKey("wallet", "user-b"), "1m");
  assert.equal(readBalanceRange(cache, balanceRangeKey("wallet", "user-a")), "all");
  assert.equal(readBalanceRange(cache, balanceRangeKey("wallet", "user-b")), "1m");
  assert.equal(readBalanceRange(cache, balanceRangeKey("another", "user-a")), "3m");
  assert.equal(balanceRangeKey("wallet", undefined), null);
});

test("missing, obsolete and malformed preferences fall back without writing them", () => {
  const cache = storage();
  const key = balanceRangeKey("wallet", "user-a");
  for (const value of [null, "", "13m", "{broken", "undefined"]) {
    if (value !== null) cache.setItem(key, value);
    assert.equal(readBalanceRange(cache, key), "3m");
  }
  assert.equal(writeBalanceRange(cache, key, "invalid"), false);
  assert.equal(writeBalanceRange(cache, null, "all"), false);
});

test("blocked or unavailable browser storage never crashes reading or writing", () => {
  const blocked = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceededError"); } };
  assert.equal(readBalanceRange(blocked, "key"), "3m");
  assert.equal(writeBalanceRange(blocked, "key", "all"), false);
  assert.equal(readBalanceRange(undefined, "key"), "3m");
  assert.equal(writeBalanceRange(undefined, "key", "all"), false);
});

test("the hook restores the logged-in user's range without overwriting it during account changes", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const cache = storage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: cache });
  let renderer;
  try {
    const seen = [];
    let choose;
    const View = ({ userId }) => {
      const [range, select] = useBalanceRange("wallet", userId);
      choose = select;
      seen.push({ userId, range });
      return React.createElement("span", null, range);
    };
    act(() => { renderer = TestRenderer.create(React.createElement(View, { userId: undefined })); });
    assert.equal(cache.values.size, 0);
    act(() => { renderer.update(React.createElement(View, { userId: "a" })); });
    act(() => { choose("all"); });
    act(() => { renderer.update(React.createElement(View, { userId: "b" })); });
    assert.equal(renderer.toJSON().children[0], "3m");
    act(() => { choose("1y"); });
    act(() => { renderer.update(React.createElement(View, { userId: "a" })); });
    assert.equal(renderer.toJSON().children[0], "all");
    assert.equal(cache.getItem(balanceRangeKey("wallet", "a")), "all");
    assert.equal(cache.getItem(balanceRangeKey("wallet", "b")), "1y");
    assert.ok(seen.filter(entry => entry.userId === "b").every(entry => entry.range !== "all"));
    act(() => { renderer.unmount(); });
    act(() => { renderer = TestRenderer.create(React.createElement(View, { userId: "a" })); });
    assert.equal(renderer.toJSON().children[0], "all");
  } finally {
    if (renderer) act(() => { renderer.unmount(); });
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
});
