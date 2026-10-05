import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const listeners = new Set(), authListeners = new Set(), events = new Map();
const values = new Map();
const ctx = {
  db: { app: { options: { projectId: "frontend-test" } } }, auth: { currentUser: null },
  store: new Map(), calls: 0, fail: false, readGate: null,
};
const snapshot = ref => ({ exists: () => ctx.store.has(ref.path), data: () => structuredClone(ctx.store.get(ref.path)) });
const emit = subscription => subscription.callback(subscription.ref.path === "expenses"
  ? { docs: [...ctx.store].filter(([path]) => path.startsWith("expenses/")).map(([path, data]) => ({ id: path.split("/")[1], data: () => structuredClone(data) })) }
  : snapshot(subscription.ref));
const publish = path => { for (const subscription of listeners) if (subscription.ref.path === path || path.startsWith("expenses/") && subscription.ref.path === "expenses") emit(subscription); };
const authChange = uid => { ctx.auth.currentUser = uid ? { uid } : null; for (const callback of authListeners) callback(ctx.auth.currentUser); };
const sdk = {
  ...ctx,
  doc: (_db, ...parts) => ({ path: parts.join("/"), id: parts.at(-1) }),
  collection: (_db, path) => ({ path }), query: ref => ref, orderBy: () => null, where: () => null,
  onSnapshot(ref, callback) { const subscription = { ref, callback }; listeners.add(subscription); return () => listeners.delete(subscription); },
  onAuthStateChanged(auth, callback) { authListeners.add(callback); queueMicrotask(() => callback(auth.currentUser)); return () => authListeners.delete(callback); },
  getRedirectResult: async () => null, signInWithPopup: async () => null, signInWithRedirect: async () => null,
  signOut: async () => authChange(null), getDocsFromServer: async () => ({ docs: [] }),
  async runTransaction(_db, callback) {
    ctx.calls++;
    if (ctx.fail) throw new Error("offline");
    const writes = [];
    const result = await callback({
      async get(ref) { if (ctx.readGate) await ctx.readGate; return snapshot(ref); },
      set(ref, data, options) { writes.push({ ref, data, merge: options?.merge }); },
      update(ref, data) { writes.push({ ref, data, merge: true }); },
      delete(ref) { writes.push({ ref, remove: true }); },
    });
    for (const { ref, data, merge, remove } of writes) {
      if (remove) ctx.store.delete(ref.path);
      else ctx.store.set(ref.path, merge ? { ...ctx.store.get(ref.path), ...data } : data);
    }
    for (const { ref } of writes) publish(ref.path);
    return result;
  },
};
globalThis.__dateWalletFrontendTest = sdk;
let App, renderer;
const descriptors = new Map();
before(async () => {
  for (const key of ["window", "document", "localStorage"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const add = (name, callback) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); };
  const remove = (name, callback) => events.get(name)?.delete(callback);
  globalThis.window = { addEventListener: add, removeEventListener: remove, EventTarget,
    TouchEvent: class extends Event {
      constructor(type, y = 0) { super(type, { cancelable: true }); this.touches = [{ clientX: 10, clientY: y }]; }
    } };
  globalThis.document = { visibilityState: "visible", addEventListener: add, removeEventListener: remove, getSelection: () => null };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/App.jsx", import.meta.url))], bundle: true, write: false,
    format: "esm", platform: "node", jsx: "automatic",
    plugins: [{ name: "frontend-test-sdk", setup(builder) {
      builder.onResolve({ filter: /^(react(?:\/jsx-runtime)?|react-dom|@dnd-kit\/(core|sortable|utilities))$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
      builder.onResolve({ filter: /^(\.\/firebase|firebase\/(auth|firestore))$/ }, () => ({ path: "sdk", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: `const sdk = globalThis.__dateWalletFrontendTest; ${Object.keys(sdk).map(key => `export const ${key} = sdk.${key};`).join("\n")} export const googleProvider = {};` }));
    } }],
  });
  try {
    App = (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`)).default;
  } catch (error) {
    // コンパイルしたソース全体のdata URLがスタックに繰り返し出ることを避けます。
    throw new Error(error.message);
  }
});
after(() => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
  delete globalThis.__dateWalletFrontendTest;
});
beforeEach(context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: new Date(2026, 9, 5).getTime() });
  context.mock.method(console, "error", () => {});
  ctx.store.clear(); ctx.calls = 0; ctx.fail = false; ctx.readGate = null;
  ctx.auth.currentUser = { uid: "member-a" };
  values.clear(); listeners.clear(); authListeners.clear(); events.clear();
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = null; });
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
const mount = async () => { await act(async () => { renderer = TestRenderer.create(React.createElement(App)); await flush(); }); };
const tick = async (context, milliseconds) => { await act(async () => { context.mock.timers.tick(milliseconds); await flush(); }); };
const setup = (count = 1) => {
  ctx.store.set("settings/shared", { categories: [{ id: "food", label: "食事", emoji: "🍽", color: "#C4785A" }, { id: "other", label: "その他", emoji: "✦", color: "#888888" }] });
  ctx.store.set("settings/recurring", { items: Array.from({ length: count }, (_, index) => ({ id: `rec-${index}`, title: `定期${index}`, amount: 100, category: "other", startMonth: "2026-10", intervalMonths: 1, dayOfMonth: 1, active: true })) });
};
const push = async (...paths) => { await act(async () => { for (const path of paths) publish(path); await flush(); }); };
const button = text => renderer.root.findAllByType("button").find(node => node.children.join("") === text);

test("recurring settings arriving first wait for the initial expense snapshot", async context => {
  setup(); await mount();
  await push("settings/recurring"); await tick(context, 1500);
  assert.equal(ctx.calls, 0);
  await push("expenses"); await tick(context, 600);
  assert.equal(ctx.calls, 1);
  assert.equal([...ctx.store.keys()].filter(key => key.startsWith("expenses/")).length, 1);
});

test("expenses arriving first also wait for recurring settings", async context => {
  setup(); await mount(); await push("expenses"); await tick(context, 1500);
  assert.equal(ctx.calls, 0);
  await push("settings/recurring"); await tick(context, 600);
  assert.equal(ctx.calls, 1);
});

test("snapshot updates during a batch do not interrupt the remaining recurring expenses", async context => {
  setup(3); await mount(); await push("expenses", "settings/recurring"); await tick(context, 600);
  assert.equal(ctx.calls, 3);
  await tick(context, 1500);
  assert.equal(ctx.calls, 3);
});

test("logout during an in-flight transaction aborts its writes", async context => {
  setup(); await mount(); await push("expenses", "settings/recurring");
  let release; ctx.readGate = new Promise(resolve => { release = resolve; });
  await tick(context, 600);
  assert.equal(ctx.calls, 1);
  await act(async () => { authChange(null); release(); await flush(); });
  assert.equal([...ctx.store.keys()].filter(key => key.startsWith("expenses/")).length, 0);
});

test("late callbacks from the previous user do not enable posting for the new account", async context => {
  setup(); await mount();
  const previous = [...listeners];
  await act(async () => { authChange("member-b"); await flush(); });
  await act(async () => { for (const subscription of previous) emit(subscription); await flush(); });
  await tick(context, 1000);
  assert.equal(ctx.calls, 0);
  await push("expenses", "settings/recurring"); await tick(context, 600);
  assert.equal(ctx.calls, 1);
});

test("offline errors do not loop and an online event retries the pending expense", async context => {
  setup(); ctx.fail = true; await mount(); await push("expenses", "settings/recurring"); await tick(context, 600);
  assert.equal(ctx.calls, 1);
  await tick(context, 10000); assert.equal(ctx.calls, 1);
  ctx.fail = false;
  await act(async () => { for (const callback of events.get("online")) callback(); await flush(); });
  await tick(context, 600);
  assert.equal(ctx.calls, 2);
  assert.equal([...ctx.store.keys()].filter(key => key.startsWith("expenses/")).length, 1);
});

test("dropping a category saves its relative position and updates the home category order", async () => {
  setup(0); await mount(); await push("settings/shared");
  await act(async () => button("設定").props.onClick());
  const dnd = renderer.root.findAll(node => typeof node.props.onDragEnd === "function")[0];
  await act(async () => { await dnd.props.onDragEnd({ active: { id: "other" }, over: { id: "food" } }); await flush(); });
  assert.deepEqual(ctx.store.get("settings/shared").categories.map(category => category.id), ["other", "food"]);
  await act(async () => button("記録").props.onClick());
  const filters = renderer.root.findAllByType("button").filter(node => node.children.join("") === "✦ その他" || node.children.join("") === "🍽 食事");
  assert.deepEqual(filters.map(node => node.children.join("")), ["✦ その他", "🍽 食事"]);
});

test("a cancelled drag or a drop at the same position does not save anything", async () => {
  setup(0); await mount(); await push("settings/shared");
  await act(async () => button("設定").props.onClick());
  const dnd = renderer.root.findAll(node => typeof node.props.onDragEnd === "function")[0];
  await act(async () => { dnd.props.onDragStart({ active: { id: "other" } }); dnd.props.onDragCancel(); await flush(); });
  await act(async () => { await dnd.props.onDragEnd({ active: { id: "other" }, over: null }); await dnd.props.onDragEnd({ active: { id: "other" }, over: { id: "other" } }); });
  assert.equal(ctx.calls, 0);
  assert.deepEqual(ctx.store.get("settings/shared").categories.map(category => category.id), ["food", "other"]);
});

test("a failed reorder restores the shared order and does not trap the next drag", async () => {
  setup(0); await mount(); await push("settings/shared");
  await act(async () => button("設定").props.onClick());
  const dnd = renderer.root.findAll(node => typeof node.props.onDragEnd === "function")[0];
  ctx.fail = true;
  await act(async () => { await dnd.props.onDragEnd({ active: { id: "other" }, over: { id: "food" } }); await flush(); });
  const rows = () => renderer.root.findAll(node => node.type === "div" && node.props["data-category-id"]);
  assert.deepEqual(rows().map(node => node.props["data-category-id"]), ["food", "other"]);
  ctx.fail = false;
  await act(async () => { await dnd.props.onDragEnd({ active: { id: "other" }, over: { id: "food" } }); await flush(); });
  assert.deepEqual(rows().map(node => node.props["data-category-id"]), ["other", "food"]);
});

test("a pending drag saves only once while displaying the requested order", async () => {
  setup(0); await mount(); await push("settings/shared");
  await act(async () => button("設定").props.onClick());
  const dnd = renderer.root.findAll(node => typeof node.props.onDragEnd === "function")[0];
  let release; ctx.readGate = new Promise(resolve => { release = resolve; });
  let saving;
  await act(async () => { saving = dnd.props.onDragEnd({ active: { id: "other" }, over: { id: "food" } }); await flush(); });
  assert.deepEqual(renderer.root.findAll(node => node.type === "div" && node.props["data-category-id"]).map(node => node.props["data-category-id"]), ["other", "food"]);
  await act(async () => { await dnd.props.onDragEnd({ active: { id: "food" }, over: { id: "other" } }); release(); await saving; await flush(); });
  assert.equal(ctx.calls, 1);
});

const touchGesture = () => {
  const dnd = renderer.root.findAll(node => typeof node.props.onDragEnd === "function")[0];
  const { sensor: Sensor, options } = dnd.props.sensors.find(item => item.sensor.name === "TouchSensor");
  const target = new EventTarget();
  const initial = new window.TouchEvent("touchstart");
  target.dispatchEvent(initial);
  const state = { started: 0, cancelled: 0, moves: [] };
  const sensor = new Sensor({ active: "other", event: initial, options,
    onPending: () => {}, onAbort: () => {}, onEnd: () => {},
    onStart: () => state.started++, onCancel: () => state.cancelled++, onMove: coordinates => state.moves.push(coordinates),
  });
  const send = (type, y) => { const event = new window.TouchEvent(type, y); target.dispatchEvent(event); return event; };
  return { sensor, state, send };
};

test("swiping before the hold delay stays scrollable and cancels drag activation", async context => {
  setup(0); await mount(); await push("settings/shared");
  await act(async () => button("設定").props.onClick());
  const { sensor, state, send } = touchGesture();
  try {
    const swipe = send("touchmove", 30);
    assert.equal(swipe.defaultPrevented, false);
    await tick(context, 500);
    assert.equal(state.started, 0);
    assert.equal(state.cancelled, 1);
    assert.equal(ctx.calls, 0);
  } finally { sensor.detach(); }
});

test("holding activates dragging and blocks scrolling only until the gesture is cancelled", async context => {
  setup(0); await mount(); await push("settings/shared");
  await act(async () => button("設定").props.onClick());
  const { sensor, state, send } = touchGesture();
  try {
    await tick(context, 349); assert.equal(state.started, 0);
    await tick(context, 1); assert.equal(state.started, 1);
    assert.equal(send("touchmove", 60).defaultPrevented, true);
    assert.deepEqual(state.moves, [{ x: 10, y: 60 }]);
    send("touchcancel");
    assert.equal(state.cancelled, 1);
    assert.equal(send("touchmove", 90).defaultPrevented, false);
  } finally { sensor.detach(); }
});

test("two submit events from the same expense form create only one record", async () => {
  setup(0); await mount(); await push("settings/shared");
  await act(async () => renderer.root.findByProps({ className: "fab" }).props.onClick());
  await act(async () => renderer.root.findAllByType("input").find(node => node.props.inputMode === "numeric").props.onChange({ target: { value: "100" } }));
  const submit = button("記録する");
  await act(async () => { const first = submit.props.onClick(); const second = submit.props.onClick(); await Promise.all([first, second]); await flush(); });
  assert.equal(ctx.calls, 1);
  assert.equal([...ctx.store.keys()].filter(key => key.startsWith("expenses/")).length, 1);
});

test("switching accounts during posting does not apply the old account's failure backoff to the new one", async context => {
  setup(); await mount(); await push("expenses", "settings/recurring");
  let release; ctx.readGate = new Promise(resolve => { release = resolve; });
  await tick(context, 600);
  await act(async () => { authChange("member-b"); release(); ctx.readGate = null; await flush(); });
  await push("expenses", "settings/recurring"); await tick(context, 600);
  assert.equal(ctx.calls, 2);
  assert.equal([...ctx.store.keys()].filter(key => key.startsWith("expenses/")).length, 1);
});
