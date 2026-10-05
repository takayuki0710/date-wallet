import { useState, useEffect, useRef } from "react";
import {
  collection, doc, onSnapshot, query, orderBy, where, getDocsFromServer, runTransaction
} from "firebase/firestore";
import { signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from "firebase/auth";
import { db, auth, googleProvider } from "./firebase";
import {
  INTERVAL_OPTIONS, createRecurringForm, normalizeRecurringForm,
  computePendingRecurringExpenses, postRecurringExpense,
} from "./recurringExpenses";
import { BALANCE_RANGES } from "./chartPreferences.js";
import { useBalanceRange } from "./useBalanceRange.js";
import CategoryList from "./CategoryList.jsx";
import {
  WalletError, saveExpense, confirmExpenseAmount, deleteExpenseRecord,
  saveRecurringTemplate, setRecurringActive, deleteRecurringTemplate, saveCategory,
  deleteCategory, moveCategory,
} from "./walletTransactions.js";

const DEFAULT_CATEGORIES = [
  { id: "food", label: "食事", emoji: "🍽", color: "#C4785A" },
  { id: "cafe", label: "カフェ", emoji: "☕", color: "#A0845C" },
  { id: "movie", label: "映画", emoji: "🎬", color: "#6B7FA3" },
  { id: "shopping", label: "買い物", emoji: "🛍", color: "#7A9E7E" },
  { id: "travel", label: "おでかけ", emoji: "🚃", color: "#8E7AAB" },
  { id: "hotel", label: "宿泊", emoji: "🏨", color: "#A07A8E" },
  { id: "entertainment", label: "遊び", emoji: "🎡", color: "#B8965A" },
  { id: "other", label: "その他", emoji: "✦", color: "#888888" },
];

const PALETTE = [
  "#C4785A", "#A0845C", "#6B7FA3", "#7A9E7E", "#8E7AAB",
  "#A07A8E", "#B8965A", "#888888", "#5A8C9E", "#9E5A6B",
  "#6B9E5A", "#9E855A", "#5A6B9E", "#9E5A85", "#5A9E8C",
];

const EMOJI_GROUPS = [
  { label: "食べ物・飲み物", emojis: ["🍽", "🍜", "🍣", "🍱", "🍕", "🍔", "🌮", "🥗", "🍩", "🍰", "🎂", "🍦", "🧁", "☕", "🧋", "🍵", "🍺", "🍷", "🥂", "🍸", "🧃", "🍹"] },
  { label: "おでかけ・旅行", emojis: ["🚃", "✈️", "🚗", "🚢", "🏨", "🏖", "🏔", "⛺", "🗼", "🏯", "🌏", "🗺", "🚁", "🚂", "🛳", "🚴", "🛺", "🗽", "🌅", "🎡", "🎢", "🎠"] },
  { label: "スポーツ・趣味", emojis: ["🏋", "⚽", "🎾", "🏊", "🎿", "🎯", "🎱", "♟", "🏄", "🧗", "🤸", "🎳", "🎸", "🎹", "🎨", "📸", "🎤", "🎵", "🎮", "🕹", "🎲", "📚", "✏️", "🧩"] },
  { label: "ショッピング・ファッション", emojis: ["🛍", "👗", "👠", "👟", "👜", "💄", "💍", "⌚", "🕶", "🧴", "🌂", "🛒", "💎", "🪞", "👒", "🧣", "🧤", "💅", "🪮", "🪭"] },
  { label: "その他", emojis: ["✦", "🌸", "🌙", "🌟", "💝", "🐾", "🐶", "🐱", "🌿", "🌺", "🎁", "💆", "🧸", "🏡", "🎉", "🩺", "💊", "📱", "💻", "🔑", "🧧", "🪴"] },
];

const fmt = (n) => "¥" + Number(n).toLocaleString("ja-JP");
const fmtShort = (n) => {
  const abs = Math.abs(n);
  if (abs >= 10000) {
    const man = n / 10000;
    return (n < 0 ? "-" : "") + Math.abs(man).toFixed(Number.isInteger(man) ? 0 : 1) + "万";
  }
  return (n < 0 ? "-¥" : "¥") + Math.abs(n).toLocaleString("ja-JP");
};
const EMPTY_FORM = { title: "", amount: "", category: "food", memo: "", date: new Date().toISOString().slice(0, 10), type: "expense" };
const EMPTY_CAT_FORM = { label: "", emoji: "🍽", color: "#C4785A" };
const pad2 = (n) => String(n).padStart(2, "0");
const localDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return localDateStr(d);
};
const monthsAgo = (dateStr, n) => {
  const d = new Date(dateStr + "T00:00:00");
  d.setMonth(d.getMonth() - n);
  return localDateStr(d);
};

// Firestore のコレクション名（二人で共有する固定ID）
const SHARED_ID = "shared";
const RECURRING_ID = "recurring";
const NEEDS_CONFIRM_COLOR = "#A08428";

export default function App() {
  const [user, setUser] = useState(undefined); // undefined=loading, null=未ログイン
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [tab, setTab] = useState("home");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editingExpenseBase, setEditingExpenseBase] = useState(null);
  const [toast, setToast] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [filterCat, setFilterCat] = useState("all");
  const [showCatForm, setShowCatForm] = useState(false);
  const [editingCatId, setEditingCatId] = useState(null);
  const [editingCategoryBase, setEditingCategoryBase] = useState(null);
  const [newCategoryPosition, setNewCategoryPosition] = useState("first");
  const [catForm, setCatForm] = useState(EMPTY_CAT_FORM);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [recurringItems, setRecurringItems] = useState([]);
  const [showRecForm, setShowRecForm] = useState(false);
  const [editingRecId, setEditingRecId] = useState(null);
  const [editingRecurringBase, setEditingRecurringBase] = useState(null);
  const [recForm, setRecForm] = useState(() => createRecurringForm());
  const [savingRecurring, setSavingRecurring] = useState(false);
  const [onlyUnconfirmed, setOnlyUnconfirmed] = useState(false);
  const [expensesUserId, setExpensesUserId] = useState(null);
  const [recurringUserId, setRecurringUserId] = useState(null);
  const postingIds = useRef(new Set());
  const postingFailures = useRef(new Map());
  const [postingRecurring, setPostingRecurring] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [savingExpense, setSavingExpense] = useState(false);
  const savingExpenseRef = useRef(false);
  const savingRecurringRef = useRef(false);
  const savingCategoryRef = useRef(false);
  const [savingCategory, setSavingCategory] = useState(false);
  const [balanceRange, setBalanceRange] = useBalanceRange(db.app.options.projectId, user?.uid);
  const [balanceHoverIdx, setBalanceHoverIdx] = useState(null);
  const balanceSvgRef = useRef(null);

  // 認証状態を監視
  useEffect(() => {
    getRedirectResult(auth)
      .then((result) => {
        if (result?.user) setUser(result.user);
      })
      .catch(console.error);
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u ?? null); // nullも含めて必ずセットする
    });
    return unsub;
  }, []);

  // Firestore からリアルタイムでデータ取得
  useEffect(() => {
    setExpensesUserId(null);
    setRecurringUserId(null);
    setExpenses([]);
    setRecurringItems([]);
    setCategories(DEFAULT_CATEGORIES);
    setShowForm(false);
    setShowRecForm(false);
    setShowCatForm(false);
    setConfirmDialog(null);
    postingFailures.current.clear();
    if (!user) return;
    let active = true;

    const expQ = query(collection(db, "expenses"), orderBy("date", "desc"));
    const unsubExp = onSnapshot(expQ, (snap) => {
      if (!active) return;
      setExpenses(snap.docs.map(d => ({ ...d.data(), id: d.id })));
      setExpensesUserId(user.uid);
    }, error => {
      if (!active) return;
      setExpensesUserId(null);
      console.error(error);
      showToast("記録を読み込めませんでした");
    });

    const unsubCat = onSnapshot(doc(db, "settings", SHARED_ID), (snap) => {
      if (!active) return;
      if (snap.exists() && snap.data().categories) {
        setCategories(snap.data().categories);
      }
    });

    const unsubRec = onSnapshot(doc(db, "settings", RECURRING_ID), (snap) => {
      if (!active) return;
      setRecurringItems(snap.data()?.items || []);
      setRecurringUserId(user.uid);
    }, (error) => {
      if (!active) return;
      setRecurringUserId(null);
      console.error(error);
      showToast("定期支出の設定を読み込めませんでした");
    });

    return () => { active = false; unsubExp(); unsubCat(); unsubRec(); };
  }, [user?.uid]);

  useEffect(() => {
    const retry = () => { postingFailures.current.clear(); setRetryTick(tick => tick + 1); };
    const onVisible = () => { if (document.visibilityState === "visible") retry(); };
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => setRetryTick(tick => tick + 1), 60000);
    return () => { window.removeEventListener("online", retry); document.removeEventListener("visibilitychange", onVisible); clearInterval(timer); };
  }, []);

  const runWalletTransaction = operation => {
    const ownerId = user?.uid;
    return runTransaction(db, async transaction => {
      if (!ownerId || auth.currentUser?.uid !== ownerId) throw new WalletError("ログイン状態が変更されました。画面を開き直してください");
      const result = await operation(transaction);
      if (auth.currentUser?.uid !== ownerId) throw new WalletError("ログイン状態が変更されました。画面を開き直してください");
      return result;
    });
  };

  // 両方の初回取得を待ち、共有相手との同時計上もトランザクションで防ぎます。
  useEffect(() => {
    if (!user || postingRecurring || expensesUserId !== user.uid || recurringUserId !== user.uid) return;
    const ownerId = user.uid;
    const timer = setTimeout(async () => {
      const pending = computePendingRecurringExpenses(recurringItems, expenses).filter(entry =>
        Date.now() - (postingFailures.current.get(entry.expId) || 0) >= 60000);
      if (pending.length === 0 || auth.currentUser?.uid !== ownerId) return;
      setPostingRecurring(true);
      let posted = 0;
      let failed = false;
      for (const entry of pending) {
        if (auth.currentUser?.uid !== ownerId) break;
        if (postingIds.current.has(entry.expId)) continue;
        postingIds.current.add(entry.expId);
        try {
          const created = await runWalletTransaction(transaction => postRecurringExpense(
            transaction, doc(db, "settings", RECURRING_ID),
            doc(db, "expenses", entry.expId), entry, new Date(),
            { categoriesRef: doc(db, "settings", SHARED_ID), defaults: DEFAULT_CATEGORIES },
          ));
          if (created) posted++;
        } catch (error) {
          console.error(error);
          if (auth.currentUser?.uid === ownerId) {
            postingFailures.current.set(entry.expId, Date.now());
            failed = true;
          }
        } finally {
          postingIds.current.delete(entry.expId);
        }
      }
      setPostingRecurring(false);
      if (auth.currentUser?.uid !== ownerId) return;
      if (failed) showToast("定期支出を計上できませんでした。接続回復後に再試行します");
      else if (posted > 0) showToast(`🔁 ${posted}件の定期支出を計上しました`);
    }, 500);
    return () => clearTimeout(timer);
  }, [user?.uid, expensesUserId, recurringUserId, recurringItems, expenses, postingRecurring, retryTick]);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 1800); };

  const login = () => signInWithPopup(auth, googleProvider).catch(console.error);
  const logout = () => signOut(auth);

  // 費用の保存・更新・削除
  const submitForm = async () => {
    if (!form.amount || savingExpenseRef.current) return;
    savingExpenseRef.current = true;
    const title = form.title || fmt(Number(form.amount));
    const data = { ...form, title, amount: Number(form.amount) };
    setSavingExpense(true);
    try {
      const id = editingId || "exp_" + crypto.randomUUID();
      await runWalletTransaction(transaction => saveExpense(transaction, {
        expenseRef: doc(db, "expenses", id), categoriesRef: doc(db, "settings", SHARED_ID),
        form: data, expected: editingId ? editingExpenseBase : null, defaults: DEFAULT_CATEGORIES,
      }));
      showToast(editingId ? "✓ 更新しました" : "✓ 記録しました");
      setShowForm(false);
    } catch (error) {
      console.error(error);
      showToast(error instanceof WalletError ? error.message : "記録を保存できませんでした");
    } finally {
      savingExpenseRef.current = false;
      setSavingExpense(false);
    }
  };

  const delExpense = async (expected) => {
    try {
      await runWalletTransaction(transaction => deleteExpenseRecord(transaction, {
        expenseRef: doc(db, "expenses", expected.id), recurringRef: doc(db, "settings", RECURRING_ID),
        categoriesRef: doc(db, "settings", SHARED_ID), expected,
      }));
      showToast("削除しました");
    } catch (error) {
      console.error(error);
      showToast(error instanceof WalletError ? error.message : "記録を削除できませんでした");
    }
  };

  const confirmExpense = async (expected) => {
    try {
      await runWalletTransaction(transaction => confirmExpenseAmount(transaction, doc(db, "expenses", expected.id), expected));
      showToast("✓ 確認しました");
    } catch (error) {
      console.error(error);
      showToast(error instanceof WalletError ? error.message : "金額を確認済みにできませんでした");
    }
  };

  const askDeleteExpense = (e) => {
    setConfirmDialog({
      kind: "expense",
      title: "この記録を削除しますか？",
      body: e.title,
      sub: `${e.date.slice(5).replace("-", "/")}・${e.type === "income" ? "入金" : cat(e.category)?.label} ・ ${e.type === "income" ? "+" : ""}${fmt(e.amount)}`,
      onConfirm: () => delExpense(e),
    });
  };

  const askDeleteCategory = (c) => {
    if (expenses.some(e => e.category === c.id) || recurringItems.some(r => r.category === c.id)) {
      showToast("使用中のカテゴリは削除できません");
      return;
    }
    setConfirmDialog({
      kind: "category",
      title: "このカテゴリを削除しますか？",
      body: `${c.emoji} ${c.label}`,
      sub: "未使用のため削除可能です",
      onConfirm: () => delCategory(c.id),
    });
  };

  // カテゴリの保存・削除
  const submitCatForm = async () => {
    if (!catForm.label.trim() || savingCategoryRef.current) return;
    savingCategoryRef.current = true;
    setSavingCategory(true);
    try {
      const id = editingCatId || "cat_" + crypto.randomUUID();
      await runWalletTransaction(transaction => saveCategory(transaction, {
        categoriesRef: doc(db, "settings", SHARED_ID), id, form: catForm,
        expected: editingCatId ? editingCategoryBase : null, defaults: DEFAULT_CATEGORIES,
        position: newCategoryPosition,
      }));
      showToast(editingCatId ? "✓ カテゴリを更新しました" : "✓ カテゴリを追加しました");
      setShowCatForm(false);
    } catch (error) {
      console.error(error);
      showToast(error instanceof WalletError ? error.message : "カテゴリを保存できませんでした");
    } finally {
      savingCategoryRef.current = false;
      setSavingCategory(false);
    }
  };

  const reorderCategory = async (move) => {
    try {
      await runWalletTransaction(transaction => moveCategory(transaction, {
        categoriesRef: doc(db, "settings", SHARED_ID), ...move, defaults: DEFAULT_CATEGORIES,
      }));
      return true;
    } catch (error) {
      console.error(error);
      showToast(error instanceof WalletError ? error.message : "カテゴリの並び順を変更できませんでした");
      return false;
    }
  };

  const delCategory = async (id) => {
    if (expenses.some(e => e.category === id) || recurringItems.some(r => r.category === id)) {
      showToast("使用中のカテゴリは削除できません");
      return;
    }
    try {
      await runWalletTransaction(transaction => deleteCategory(transaction, {
        categoriesRef: doc(db, "settings", SHARED_ID), recurringRef: doc(db, "settings", RECURRING_ID),
        id, defaults: DEFAULT_CATEGORIES,
        loadExpenses: async () => {
          const snapshot = await getDocsFromServer(query(collection(db, "expenses"), where("category", "==", id)));
          return snapshot.docs.map(document => document.data());
        },
      }));
      showToast("カテゴリを削除しました");
    } catch (error) {
      console.error(error);
      showToast(error instanceof WalletError ? error.message : "カテゴリを削除できませんでした");
    }
  };

  const submitRecForm = async () => {
    const data = normalizeRecurringForm(recForm);
    if (!data || !categories.some(c => c.id === data.category) || savingRecurringRef.current) return;
    savingRecurringRef.current = true;
    setSavingRecurring(true);
    try {
      const id = editingRecId || "rec_" + crypto.randomUUID();
      await runWalletTransaction(transaction => saveRecurringTemplate(transaction, {
        recurringRef: doc(db, "settings", RECURRING_ID), categoriesRef: doc(db, "settings", SHARED_ID),
        id, form: data, expected: editingRecId ? editingRecurringBase : null, defaults: DEFAULT_CATEGORIES,
      }));
      showToast(editingRecId ? "✓ 定期支出を更新しました" : "✓ 定期支出を追加しました");
      setShowRecForm(false);
    } catch (error) {
      console.error(error);
      showToast(error instanceof WalletError ? error.message : "定期支出を保存できませんでした");
    } finally {
      savingRecurringRef.current = false;
      setSavingRecurring(false);
    }
  };

  const delRecurring = async (expected) => {
    try {
      await runWalletTransaction(transaction => deleteRecurringTemplate(transaction, doc(db, "settings", RECURRING_ID), expected));
      showToast("定期支出を削除しました");
    } catch (error) {
      console.error(error);
      showToast(error instanceof WalletError ? error.message : "定期支出を削除できませんでした");
    }
  };

  const toggleRecurring = async (item) => {
    try {
      await runWalletTransaction(transaction => setRecurringActive(transaction, doc(db, "settings", RECURRING_ID), item.id, !item.active));
    } catch (error) {
      console.error(error);
      showToast(error instanceof WalletError ? error.message : "定期支出の状態を変更できませんでした");
    }
  };

  const askDeleteRecurring = (item) => {
    setConfirmDialog({
      kind: "recurring", body: item.title,
      sub: `${cat(item.category).label} ・ ${fmt(item.amount)}`,
      onConfirm: () => delRecurring(item),
    });
  };

  const openAdd = () => { setEditingId(null); setEditingExpenseBase(null); setForm({ ...EMPTY_FORM, date: localDateStr(new Date()), category: categories[0]?.id || "food" }); setShowForm(true); };
  const openEdit = (e) => {
    setEditingId(e.id);
    setEditingExpenseBase(e);
    setForm({ title: e.title, amount: String(e.amount), category: e.category, memo: e.memo || "", date: e.date, type: e.type || "expense" });
    setShowForm(true);
  };
  const openAddCat = () => { setEditingCatId(null); setEditingCategoryBase(null); setNewCategoryPosition("first"); setCatForm(EMPTY_CAT_FORM); setShowCatForm(true); };
  const openEditCat = (c) => { setEditingCatId(c.id); setEditingCategoryBase(c); setCatForm({ label: c.label, emoji: c.emoji, color: c.color }); setShowCatForm(true); };
  const openAddRec = () => { setEditingRecId(null); setEditingRecurringBase(null); setRecForm(createRecurringForm(categories[0]?.id || "food")); setShowRecForm(true); };
  const openEditRec = (item) => {
    setEditingRecId(item.id);
    setEditingRecurringBase(item);
    setRecForm({ ...item, amount: String(item.amount), amountVaries: !!item.amountVaries });
    setShowRecForm(true);
  };

  const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().slice(0, 7));
  const cat = (id) => categories.find(c => c.id === id) || { emoji: "✦", label: "不明", color: "#888" };
  const categoryFiltered = filterCat === "all" ? expenses : expenses.filter(e => e.category === filterCat);
  const filtered = onlyUnconfirmed ? categoryFiltered.filter(e => e.needsConfirmation) : categoryFiltered;
  const unconfirmedCount = expenses.filter(e => e.needsConfirmation).length;
  const validRecForm = !!normalizeRecurringForm(recForm) && categories.some(c => c.id === recForm.category);
  const monthlyAll = expenses.filter(e => e.date.slice(0, 7) === selectedMonth);
  const monthlyExpenses = monthlyAll.filter(e => (e.type || "expense") === "expense");
  const monthlyIncome = monthlyAll.filter(e => e.type === "income");
  const total = monthlyExpenses.reduce((s, e) => s + e.amount, 0);
  const totalIncome = monthlyIncome.reduce((s, e) => s + e.amount, 0);
  const allTimeExpense = expenses.filter(e => (e.type || "expense") === "expense").reduce((s, e) => s + e.amount, 0);
  const allTimeIncome = expenses.filter(e => e.type === "income").reduce((s, e) => s + e.amount, 0);
  const walletBalance = allTimeIncome - allTimeExpense;
  const byCategory = categories.map(c => {
    const items = monthlyExpenses.filter(e => e.category === c.id);
    return { ...c, total: items.reduce((s, e) => s + e.amount, 0), count: items.length };
  }).filter(c => c.total > 0).sort((a, b) => b.total - a.total);
  const grouped = filtered.reduce((acc, e) => {
    const m = e.date.slice(0, 7);
    if (!acc[m]) acc[m] = [];
    acc[m].push(e);
    return acc;
  }, {});
  const balanceSeries = (() => {
    const todayStr = localDateStr(new Date());
    if (expenses.length === 0) return { points: [], todayStr };
    const sorted = [...expenses].sort((a, b) => a.date.localeCompare(b.date));
    let running = 0;
    const runningByDate = {};
    sorted.forEach(e => {
      running += e.type === "income" ? e.amount : -e.amount;
      runningByDate[e.date] = running;
    });
    const firstDate = sorted[0].date;
    const sortedDates = Object.keys(runningByDate).sort();
    const selected = BALANCE_RANGES.find(r => r.id === balanceRange) || BALANCE_RANGES[1];
    let startDate = selected.months == null ? firstDate : monthsAgo(todayStr, selected.months);
    if (startDate > todayStr) startDate = todayStr;

    let bal = 0;
    sortedDates.forEach(dt => { if (dt <= startDate) bal = runningByDate[dt]; });

    const points = [];
    let cur = startDate;
    let guard = 0;
    while (cur <= todayStr && guard < 3660) {
      if (runningByDate[cur] !== undefined) bal = runningByDate[cur];
      points.push({ date: cur, balance: bal });
      cur = addDays(cur, 1);
      guard++;
    }
    return { points, todayStr };
  })();

  const S = {
    input: { width: "100%", padding: "11px 14px", border: "1.5px solid #E8E0D8", borderRadius: 10, fontFamily: "DM Sans, sans-serif", fontSize: 15, background: "#F7F3EE", color: "#2C2420", outline: "none" },
    label: { fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: "#9A8E86", textTransform: "uppercase", marginBottom: 6, display: "block" },
    card: { background: "#fff", borderRadius: 14, padding: "14px 16px", marginBottom: 6, border: "1px solid #E8E0D8" },
  };

  // ローディング中
  if (user === undefined) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#F7F3EE", fontFamily: "DM Sans, sans-serif", color: "#9A8E86" }}>
        読み込み中...
      </div>
    );
  }

  // 未ログイン
  if (!user) {
    return (
      <>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@400;600&display=swap'); * { box-sizing: border-box; margin: 0; padding: 0; } body { background: #F7F3EE; }`}</style>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", background: "#F7F3EE", padding: 24 }}>
          <div style={{ fontFamily: "DM Serif Display", fontSize: 36, color: "#2C2420", lineHeight: 1.2, textAlign: "center", marginBottom: 8 }}>
            Date<br /><em style={{ color: "#B5755A" }}>Wallet</em>
          </div>
          <div style={{ fontSize: 13, color: "#9A8E86", marginBottom: 40, fontFamily: "DM Sans" }}>デート家計簿</div>
          <button onClick={login} style={{
            display: "flex", alignItems: "center", gap: 12,
            background: "#fff", border: "1.5px solid #E8E0D8", borderRadius: 14,
            padding: "14px 28px", cursor: "pointer", fontFamily: "DM Sans", fontWeight: 600, fontSize: 15, color: "#2C2420",
            boxShadow: "0 2px 12px rgba(44,36,32,0.1)",
          }}>
            <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20H24v8h11.3C33.6 33.2 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.7 1.1 7.8 2.9l5.7-5.7C34 6.5 29.3 4.5 24 4.5 13.2 4.5 4.5 13.2 4.5 24S13.2 43.5 24 43.5c10.8 0 20-8.7 20-20 0-1.2-.1-2.3-.4-3.5z" /><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.5 15.1 18.9 12 24 12c3 0 5.7 1.1 7.8 2.9l5.7-5.7C34 6.5 29.3 4.5 24 4.5c-7.7 0-14.3 4.3-17.7 10.2z" /><path fill="#4CAF50" d="M24 43.5c5.2 0 9.9-1.9 13.4-5l-6.2-5.2C29.4 34.9 26.8 36 24 36c-5.2 0-9.6-3.4-11.2-8.1l-6.5 5C9.6 39.1 16.3 43.5 24 43.5z" /><path fill="#1976D2" d="M43.6 20H24v8h11.3c-.8 2.3-2.4 4.3-4.5 5.7l6.2 5.2C41.4 36 44 30.4 44 24c0-1.2-.1-2.3-.4-3.5z" /></svg>
            Googleでログイン
          </button>
          <div style={{ fontSize: 12, color: "#B8B0A8", marginTop: 20, fontFamily: "DM Sans", textAlign: "center", lineHeight: 1.7 }}>
            二人で同じGoogleアカウントでログインするか<br />
            それぞれのアカウントでログインしてください
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #F7F3EE; font-family: 'DM Sans', sans-serif; color: #2C2420; }
        input, select { transition: border-color 0.2s, box-shadow 0.2s; }
        input:focus, select:focus { border-color: #B5755A !important; box-shadow: 0 0 0 3px rgba(181,117,90,0.1); outline: none; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes sheetUp { from { opacity: 0; transform: translateY(100%); } to { opacity: 1; transform: translateY(0); } }
        @keyframes toast { 0% { opacity: 0; transform: translateX(-50%) translateY(10px); } 15%,85% { opacity: 1; transform: translateX(-50%) translateY(0); } 100% { opacity: 0; transform: translateX(-50%) translateY(-6px); } }
        .fade-in { animation: fadeIn 0.3s ease both; }
        .sheet { animation: sheetUp 0.38s cubic-bezier(.32,1,.42,1) both; }
        .row-btn { background: none; border: none; cursor: pointer; font-family: 'DM Sans', sans-serif; font-size: 12px; font-weight: 500; transition: color 0.15s; padding: 2px 0; }
        .fab { transition: transform 0.15s, box-shadow 0.15s; }
        .fab:hover { transform: translateX(-50%) scale(1.03) !important; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #E8E0D8; border-radius: 4px; }
      `}</style>

      {toast && (
        <div style={{
          position: "fixed", top: 20, left: "50%", backgroundColor: "#2C2420", color: "#fff",
          padding: "10px 22px", borderRadius: 50, zIndex: 999,
          fontFamily: "DM Sans", fontWeight: 500, fontSize: 14,
          animation: "toast 1.8s ease forwards", whiteSpace: "nowrap",
          boxShadow: "0 4px 20px rgba(0,0,0,0.18)",
        }}>{toast}</div>
      )}

<div style={{ maxWidth: 430, margin: "0 auto", minHeight: "100vh", background: "#F7F3EE", paddingBottom: 100 }}>

        {/* Header */}
        <div style={{ padding: "36px 24px 20px", borderBottom: "1px solid #E8E0D8" }}>
          {/* ロゴ ＋ 月次合計（元のレイアウト） */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
            <div>
              <div style={{ fontFamily: "DM Serif Display", fontSize: 28, color: "#2C2420", lineHeight: 1.15 }}>
                Date<br /><em style={{ color: "#B5755A" }}>Wallet</em>
              </div>
              <div style={{ fontSize: 12, color: "#9A8E86", marginTop: 6, fontWeight: 500, letterSpacing: "0.04em" }}>デート家計簿</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, color: "#9A8E86", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>Monthly Total</div>
              <select
                value={selectedMonth}
                onChange={e => setSelectedMonth(e.target.value)}
                style={{ background: "none", border: "none", fontSize: 11, color: "#9A8E86", fontFamily: "DM Sans", cursor: "pointer", marginBottom: 2, padding: 0 }}
              >
                {[...new Set(expenses.map(e => e.date.slice(0, 7)))].sort((a, b) => b.localeCompare(a)).concat(
                  [new Date().toISOString().slice(0, 7)]
                ).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => b.localeCompare(a)).map(m => (
                  <option key={m} value={m}>{m.replace("-", "年") + "月"}</option>
                ))}
              </select>
              <div style={{ fontFamily: "DM Serif Display", fontSize: 30, color: "#2C2420" }}>{fmt(total)}</div>
            </div>
          </div>

          {/* 財布残高 */}
          <div style={{ borderTop: "1px solid #E8E0D8", paddingTop: 16, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontSize: 12, color: "#9A8E86", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>Wallet Balance</div>
            <div style={{ fontFamily: "DM Serif Display", fontSize: 26, color: walletBalance >= 0 ? "#2C2420" : "#C4785A" }}>
              {walletBalance < 0 && <span style={{ fontSize: 18 }}>−</span>}{fmt(Math.abs(walletBalance))}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid #E8E0D8", background: "#fff" }}>
          {[["home", "記録"], ["chart", "集計"], ["settings", "設定"]].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              flex: 1, padding: "14px", border: "none", background: "none", cursor: "pointer",
              fontFamily: "DM Sans", fontWeight: 600, fontSize: 14,
              color: tab === id ? "#B5755A" : "#9A8E86",
              borderBottom: tab === id ? "2px solid #B5755A" : "2px solid transparent",
              transition: "all 0.2s",
            }}>{label}{id === "home" && unconfirmedCount > 0 && (
              <span style={{ marginLeft: 6, padding: "1px 5px", borderRadius: 8, background: NEEDS_CONFIRM_COLOR, color: "#fff", fontSize: 10 }}>{unconfirmedCount}</span>
            )}</button>
          ))}
        </div>

        {/* HOME */}
        {tab === "home" && (
          <div>
            {unconfirmedCount > 0 && !onlyUnconfirmed && (
              <button onClick={() => { setOnlyUnconfirmed(true); setFilterCat("all"); }} style={{
                display: "block", width: "calc(100% - 32px)", margin: "12px 16px 0", padding: "12px 14px",
                borderRadius: 12, background: "#FAF4DF", border: "1px solid #D8C788", textAlign: "left",
                fontFamily: "DM Sans", fontSize: 13, color: "#2C2420", cursor: "pointer", lineHeight: 1.6,
              }}>🔁 {unconfirmedCount}件の金額確認待ちがあります <span style={{ color: NEEDS_CONFIRM_COLOR }}>確認する →</span></button>
            )}
            <div style={{ padding: "12px 16px 12px", display: "flex", gap: 6, overflowX: "auto", borderBottom: "1px solid #E8E0D8" }}>
              {onlyUnconfirmed && (
                <button onClick={() => setOnlyUnconfirmed(false)} style={{
                  flexShrink: 0, padding: "5px 14px", borderRadius: 50, border: `1.5px solid ${NEEDS_CONFIRM_COLOR}`,
                  background: "#FAF4DF", color: NEEDS_CONFIRM_COLOR, fontFamily: "DM Sans", fontSize: 13, cursor: "pointer",
                }}>要確認のみ ✕</button>
              )}
              <button onClick={() => setFilterCat("all")} style={{
                flexShrink: 0, padding: "5px 14px", borderRadius: 50,
                border: `1.5px solid ${filterCat === "all" ? "#B5755A" : "#E8E0D8"}`,
                background: filterCat === "all" ? "#B5755A" : "transparent",
                color: filterCat === "all" ? "#fff" : "#9A8E86",
                fontFamily: "DM Sans", fontSize: 13, fontWeight: 500, cursor: "pointer",
              }}>すべて</button>
              {categories.map(c => (
                <button key={c.id} onClick={() => setFilterCat(c.id)} style={{
                  flexShrink: 0, padding: "5px 13px", borderRadius: 50,
                  border: `1.5px solid ${filterCat === c.id ? c.color : "#E8E0D8"}`,
                  background: filterCat === c.id ? c.color : "transparent",
                  color: filterCat === c.id ? "#fff" : "#9A8E86",
                  fontFamily: "DM Sans", fontSize: 13, fontWeight: 500, cursor: "pointer",
                }}>{c.emoji} {c.label}</button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <div className="fade-in" style={{ textAlign: "center", padding: "64px 24px", color: "#9A8E86" }}>
                <div style={{ fontFamily: "DM Serif Display", fontSize: 48, marginBottom: 12, opacity: 0.2 }}>✦</div>
                <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 6 }}>{onlyUnconfirmed ? "未確認の支出はありません" : "まだ記録がありません"}</div>
                {!onlyUnconfirmed && <div style={{ fontSize: 13 }}>下のボタンから追加してみてください</div>}
              </div>
            ) : (
              <div style={{ padding: "8px 0" }}>
                {Object.entries(grouped).sort((a, b) => b[0].localeCompare(a[0])).map(([month, items]) => (
                  <div key={month}>
                    <div style={{ padding: "10px 20px 6px", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "#9A8E86", textTransform: "uppercase", display: "flex", justifyContent: "space-between" }}>
                      <span>{month.replace("-", "年") + "月"}</span>
                      <span>{fmt(items.filter(e => (e.type || "expense") === "expense").reduce((s, e) => s + e.amount, 0))}</span>
                    </div>
                    {items.map((e, i) => (
                      <div key={e.id} className="fade-in" style={{ margin: "0 12px 6px", background: "#fff", borderRadius: 14, padding: "14px 16px", border: `1px solid ${e.needsConfirmation ? "#D8C788" : "#E8E0D8"}`, display: "flex", alignItems: "center", gap: 14, animationDelay: `${i * 0.04}s` }}>
                        <div style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0, background: e.type === "income" ? "#6B9E5A18" : `${cat(e.category)?.color}18`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>
                          {e.type === "income" ? "💰" : cat(e.category)?.emoji}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 15, color: "#2C2420", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title}</div>
                          <div style={{ fontSize: 12, color: "#9A8E86", marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <span>{e.date.slice(5).replace("-", "/")}</span>
                            {e.type !== "income" && <span style={{ color: cat(e.category)?.color, fontWeight: 500 }}>{cat(e.category)?.label}</span>}
                            {e.type === "income" && <span style={{ color: "#6B9E5A", fontWeight: 500 }}>入金</span>}
                            {e.recurringId && <span title="定期支出">🔁</span>}
                            {e.needsConfirmation && <span style={{ color: NEEDS_CONFIRM_COLOR, fontWeight: 600 }}>要確認</span>}
                            {e.memo && <span>— {e.memo}</span>}
                          </div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontFamily: "DM Serif Display", fontSize: 17, color: e.type === "income" ? "#6B9E5A" : "#2C2420" }}>
                            {e.type === "income" ? "+" : ""}{fmt(e.amount)}
                          </div>
                          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
                            {e.needsConfirmation && <button className="row-btn" style={{ color: NEEDS_CONFIRM_COLOR }} onClick={() => confirmExpense(e)}>確認済み</button>}
                            <button className="row-btn" style={{ color: "#B5755A" }} onClick={() => openEdit(e)}>編集</button>
                            <span style={{ color: "#E8E0D8", fontSize: 12 }}>|</span>
                            <button className="row-btn" style={{ color: "#D0C8C0" }}
                              onMouseEnter={ev => ev.target.style.color = "#C4785A"}
                              onMouseLeave={ev => ev.target.style.color = "#D0C8C0"}
                              onClick={() => askDeleteExpense(e)}>削除</button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* CHART */}
        {tab === "chart" && (
          <div style={{ padding: "20px 16px" }}>
            {byCategory.length === 0 ? (
              <div style={{ textAlign: "center", padding: "64px 24px", color: "#9A8E86" }}>
                <div style={{ fontFamily: "DM Serif Display", fontSize: 48, marginBottom: 12, opacity: 0.2 }}>✦</div>
                <div style={{ fontWeight: 500, fontSize: 15 }}>データがまだありません</div>
              </div>
            ) : (
              <>
                <div style={{ fontFamily: "DM Serif Display", fontSize: 20, marginBottom: 16, color: "#2C2420" }}>カテゴリ別 <em style={{ color: "#B5755A" }}>集計</em></div>
                {byCategory.map((c, i) => (
                  <div key={c.id} className="fade-in" style={{ background: "#fff", borderRadius: 14, padding: "16px", marginBottom: 8, border: "1px solid #E8E0D8", animationDelay: `${i * 0.05}s` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 16 }}>{c.emoji}</span>
                        <span style={{ fontWeight: 600, fontSize: 14, color: "#2C2420" }}>{c.label}</span>
                        <span style={{ fontSize: 12, color: "#9A8E86", marginLeft: 6 }}>{c.count}件</span>
                      </div>
                      <div>
                        <span style={{ fontFamily: "DM Serif Display", fontSize: 18, color: "#2C2420" }}>{fmt(c.total)}</span>
                        <span style={{ fontSize: 11, color: "#9A8E86", marginLeft: 6 }}>{total > 0 ? Math.round((c.total / total) * 100) : 0}%</span>
                      </div>
                    </div>
                    <div style={{ background: "#F7F3EE", borderRadius: 4, height: 6, overflow: "hidden" }}>
                      <div style={{ height: "100%", borderRadius: 4, background: c.color, width: `${total > 0 ? (c.total / total) * 100 : 0}%`, transition: "width 0.7s cubic-bezier(.34,1.2,.64,1)", opacity: 0.8 }} />
                    </div>
                  </div>
                ))}
                <div style={{ marginTop: 20, background: "#F0E6DF", borderRadius: 16, padding: "20px", border: "1px solid rgba(181,117,90,0.2)" }}>
                  <div style={{ fontFamily: "DM Serif Display", fontSize: 16, color: "#B5755A", marginBottom: 14 }}>Summary</div>
                  {[
                    ["合計件数", `${monthlyExpenses.length} 件`],
                    ["合計金額", fmt(total)],
                    ...(monthlyExpenses.length > 0 ? [["1回あたり平均", fmt(Math.round(total / monthlyExpenses.length))]] : []),
                  ].map(([k, v], i, arr) => (
                    <div key={k}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0" }}>
                        <div style={{ fontSize: 13, color: "#9A8E86", fontWeight: 500 }}>{k}</div>
                        <div style={{ fontFamily: "DM Serif Display", fontSize: i === 1 ? 22 : 18, color: i === 1 ? "#B5755A" : "#2C2420" }}>{v}</div>
                      </div>
                      {i < arr.length - 1 && <div style={{ height: 1, background: "rgba(181,117,90,0.15)" }} />}
                    </div>
                  ))}
                </div>
              </>
            )}

            {expenses.length > 0 && (() => {
              const { points } = balanceSeries;
              const chartW = 320, chartH = 180;
              const marginLeft = 52, marginRight = 8, marginTop = 12, marginBottom = 22;
              const plotW = chartW - marginLeft - marginRight;
              const plotH = chartH - marginTop - marginBottom;

              const values = points.map(p => p.balance);
              const domainMax = Math.max(...values, 0, 1);
              const domainMin = Math.min(...values, 0);
              const domainRange = domainMax - domainMin || 1;

              const xAt = (i) => marginLeft + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
              const yAt = (v) => marginTop + plotH - ((v - domainMin) / domainRange) * plotH;

              const linePoints = points.map((p, i) => `${xAt(i)},${yAt(p.balance)}`).join(" ");
              const areaPoints = points.length > 0
                ? `${marginLeft},${marginTop + plotH} ${linePoints} ${marginLeft + plotW},${marginTop + plotH}`
                : "";

              const yTickCount = 4;
              const yTickValues = Array.from({ length: yTickCount + 1 }, (_, i) => domainMin + (domainRange * i) / yTickCount).reverse();

              const xTickCount = Math.min(4, points.length);
              const xTickIdxs = [...new Set(
                xTickCount <= 1
                  ? [0]
                  : Array.from({ length: xTickCount }, (_, i) => Math.round((i * (points.length - 1)) / (xTickCount - 1)))
              )];

              const hoverIdx = balanceHoverIdx === null ? null : Math.max(0, Math.min(points.length - 1, balanceHoverIdx));
              const hoverPoint = hoverIdx === null ? null : points[hoverIdx];

              const updateHoverFromClientX = (clientX) => {
                const svgEl = balanceSvgRef.current;
                if (!svgEl || points.length === 0) return;
                const rect = svgEl.getBoundingClientRect();
                if (rect.width === 0) return;
                const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                const svgX = relX * chartW;
                const t = plotW > 0 ? (svgX - marginLeft) / plotW : 0;
                const idx = Math.round(Math.max(0, Math.min(1, t)) * (points.length - 1));
                setBalanceHoverIdx(idx);
              };
              const onSvgPointerDown = (e) => updateHoverFromClientX(e.clientX);
              const onSvgPointerMove = (e) => updateHoverFromClientX(e.clientX);
              const clearHover = () => setBalanceHoverIdx(null);

              const tooltipW = 100, tooltipH = 34;
              let tipX = 0, tipY = 0, hoverDateLabel = "", hoverBalanceLabel = "";
              if (hoverPoint) {
                const [hy, hm, hd] = hoverPoint.date.split("-");
                hoverDateLabel = `${hy}年${Number(hm)}月${Number(hd)}日`;
                hoverBalanceLabel = (hoverPoint.balance < 0 ? "−" : "") + fmt(Math.abs(hoverPoint.balance));
                tipX = Math.max(marginLeft, Math.min(marginLeft + plotW - tooltipW, xAt(hoverIdx) - tooltipW / 2));
                tipY = Math.max(marginTop - 2, yAt(hoverPoint.balance) - tooltipH - 10);
              }

              return (
                <div style={{ marginTop: 20, background: "#fff", borderRadius: 16, padding: "20px", border: "1px solid #E8E0D8" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <div style={{ fontFamily: "DM Serif Display", fontSize: 16, color: "#2C2420" }}>Wallet Balance <em style={{ color: "#B5755A" }}>推移</em></div>
                    <div style={{ fontFamily: "DM Serif Display", fontSize: 18, color: walletBalance >= 0 ? "#2C2420" : "#C4785A" }}>
                      {walletBalance < 0 && <span style={{ fontSize: 13 }}>−</span>}{fmt(Math.abs(walletBalance))}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
                    {BALANCE_RANGES.map(r => (
                      <button key={r.id} aria-pressed={balanceRange === r.id} onClick={() => { setBalanceRange(r.id); setBalanceHoverIdx(null); }} style={{
                        padding: "4px 11px", borderRadius: 50,
                        border: `1px solid ${balanceRange === r.id ? "#B5755A" : "#E8E0D8"}`,
                        background: balanceRange === r.id ? "#B5755A" : "transparent",
                        color: balanceRange === r.id ? "#fff" : "#9A8E86",
                        fontFamily: "DM Sans", fontSize: 11, fontWeight: 500, cursor: "pointer",
                      }}>{r.label}</button>
                    ))}
                  </div>
                  {points.length < 2 ? (
                    <div style={{ textAlign: "center", padding: "24px 0", color: "#9A8E86", fontSize: 13 }}>データが増えるとグラフが表示されます</div>
                  ) : (
                    <svg ref={balanceSvgRef} viewBox={`0 0 ${chartW} ${chartH}`} width="100%" height="180" preserveAspectRatio="none"
                      style={{ display: "block", overflow: "visible", touchAction: "none", cursor: "crosshair" }}
                      onPointerDown={onSvgPointerDown}
                      onPointerMove={onSvgPointerMove}
                      onPointerUp={clearHover}
                      onPointerCancel={clearHover}
                      onPointerLeave={clearHover}
                    >
                      <defs>
                        <linearGradient id="balanceGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#B5755A" stopOpacity="0.25" />
                          <stop offset="100%" stopColor="#B5755A" stopOpacity="0" />
                        </linearGradient>
                      </defs>

                      {yTickValues.map((v, i) => (
                        <g key={i}>
                          <line x1={marginLeft} y1={yAt(v)} x2={marginLeft + plotW} y2={yAt(v)}
                            stroke={Math.abs(v) < domainRange * 0.001 ? "#D8CFC5" : "#EFEAE4"} strokeWidth="1"
                            strokeDasharray={Math.abs(v) < domainRange * 0.001 ? "0" : "3 3"} />
                          <text x={marginLeft - 6} y={yAt(v) + 3} textAnchor="end" fontSize="9" fill="#9A8E86" fontFamily="DM Sans">
                            {fmtShort(Math.round(v))}
                          </text>
                        </g>
                      ))}

                      <line x1={marginLeft} y1={marginTop} x2={marginLeft} y2={marginTop + plotH} stroke="#D8CFC5" strokeWidth="1" />

                      <polygon points={areaPoints} fill="url(#balanceGrad)" />
                      <polyline points={linePoints} fill="none" stroke="#B5755A" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

                      {xTickIdxs.map(i => (
                        <text key={i} x={xAt(i)} y={chartH - 4}
                          textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
                          fontSize="9" fill="#9A8E86" fontFamily="DM Sans">
                          {points[i].date.slice(5).replace("-", "/")}
                        </text>
                      ))}

                      {hoverPoint && (
                        <g>
                          <line x1={xAt(hoverIdx)} y1={marginTop} x2={xAt(hoverIdx)} y2={marginTop + plotH}
                            stroke="#B5755A" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
                          <circle cx={xAt(hoverIdx)} cy={yAt(hoverPoint.balance)} r="4" fill="#B5755A" stroke="#fff" strokeWidth="1.5" />
                          <g transform={`translate(${tipX}, ${tipY})`}>
                            <rect width={tooltipW} height={tooltipH} rx="8" fill="#2C2420" opacity="0.92" />
                            <text x={tooltipW / 2} y="14" textAnchor="middle" fontSize="9" fill="#D8CFC5" fontFamily="DM Sans">{hoverDateLabel}</text>
                            <text x={tooltipW / 2} y="27" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff" fontFamily="DM Sans">{hoverBalanceLabel}</text>
                          </g>
                        </g>
                      )}
                    </svg>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {/* SETTINGS */}
        {tab === "settings" && (
          <div style={{ padding: "20px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontFamily: "DM Serif Display", fontSize: 20, color: "#2C2420" }}>カテゴリ <em style={{ color: "#B5755A" }}>管理</em></div>
              <button onClick={openAddCat} style={{ background: "#2C2420", color: "#fff", border: "none", borderRadius: 50, padding: "8px 18px", fontFamily: "DM Sans", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>+ 追加</button>
            </div>
            <CategoryList key={user.uid} categories={categories} expenses={expenses} recurringItems={recurringItems}
              onMove={reorderCategory} onEdit={openEditCat} onDelete={askDeleteCategory} />
            <div style={{ marginTop: 16, padding: "14px 16px", background: "#F0E6DF", borderRadius: 14, border: "1px solid rgba(181,117,90,0.2)", fontSize: 12, color: "#9A8E86", lineHeight: 1.7 }}>
              ✦ 使用中のカテゴリは削除できません<br />
              ✦ カテゴリ名・絵文字・カラーを自由に変更できます<br />
              ✦ 並び順は共有する全員の画面に反映されます
            </div>

            <div style={{ marginTop: 32 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div style={{ fontFamily: "DM Serif Display", fontSize: 20, color: "#2C2420" }}>定期支出 <em style={{ color: "#B5755A" }}>管理</em></div>
                <button onClick={openAddRec} style={{ background: "#2C2420", color: "#fff", border: "none", borderRadius: 50, padding: "8px 18px", fontFamily: "DM Sans", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>+ 追加</button>
              </div>
              {recurringItems.length === 0 ? (
                <div style={{ padding: 20, textAlign: "center", color: "#9A8E86", fontSize: 13 }}>定期支出はまだありません</div>
              ) : recurringItems.map((item, index) => {
                const category = cat(item.category);
                const intervalLabel = INTERVAL_OPTIONS.find(option => option.value === item.intervalMonths)?.label || `${item.intervalMonths}ヶ月ごと`;
                return (
                  <div key={item.id} className="fade-in" style={{ ...S.card, animationDelay: `${index * 0.04}s`, opacity: item.active ? 1 : 0.6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 42, height: 42, borderRadius: 12, background: `${category.color}22`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>{category.emoji}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 15, overflowWrap: "anywhere" }}>{item.title}</div>
                        <div style={{ fontSize: 12, color: "#9A8E86", marginTop: 3, lineHeight: 1.6 }}>{fmt(item.amount)} ・ {intervalLabel} ・ {item.dayOfMonth}日</div>
                        <div style={{ fontSize: 11, color: "#9A8E86", marginTop: 2 }}>{item.startMonth.replace("-", "年")}月から ・ {item.active ? "有効" : "休止中"}</div>
                        {item.amountVaries && <span style={{ display: "inline-block", marginTop: 4, fontSize: 10, color: NEEDS_CONFIRM_COLOR, border: "1px solid #D8C788", borderRadius: 4, padding: "1px 4px" }}>金額変動</span>}
                      </div>
                      <button type="button" role="switch" aria-checked={item.active} aria-label={`${item.title}の自動計上`} onClick={() => toggleRecurring(item)} style={{
                        width: 44, height: 24, borderRadius: 12, border: "none", padding: 0, cursor: "pointer", flexShrink: 0,
                        background: item.active ? "#B5755A" : "#D0C8C0", position: "relative", transition: "background 0.2s",
                      }}>
                        <span style={{ position: "absolute", top: 2, left: item.active ? 22 : 2, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                      </button>
                    </div>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10, paddingTop: 10, borderTop: "1px solid #E8E0D8" }}>
                      <button className="row-btn" style={{ color: "#B5755A" }} onClick={() => openEditRec(item)}>編集</button>
                      <span style={{ color: "#E8E0D8", fontSize: 12 }}>|</span>
                      <button className="row-btn" style={{ color: "#9A8E86" }} onClick={() => askDeleteRecurring(item)}>削除</button>
                    </div>
                  </div>
                );
              })}
              <div style={{ marginTop: 12, padding: "14px 16px", background: "#F0E6DF", borderRadius: 14, border: "1px solid rgba(181,117,90,0.2)", fontSize: 12, color: "#9A8E86", lineHeight: 1.8 }}>
                🔁 アプリを開くと、開始月から計上日を迎えた未計上分が自動で記録されます<br />
                ✦ 31日などがない月は、その月の末日に計上されます<br />
                ✦ OFF中に計上日を迎えた分は記録せず、再開日以降の計上日から記録します<br />
                ✦ 「金額が毎月変わる」をONにすると、計上後に確認待ちで表示されます<br />
                ✦ 金額確認前も、設定した金額が支出・残高に反映されます
              </div>
            </div>
          </div>
        )}

        {/* FAB */}
        {tab === "home" && (
          <button className="fab" onClick={openAdd} style={{
            position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
            background: "#2C2420", color: "#fff", border: "none", borderRadius: 50, padding: "15px 32px",
            fontFamily: "DM Sans", fontWeight: 600, fontSize: 15,
            boxShadow: "0 4px 24px rgba(44,36,32,0.28)", cursor: "pointer", zIndex: 100,
            display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap",
            maxWidth: 400, width: "calc(100% - 40px)",
          }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>+</span> 記録する
          </button>
        )}

        {/* Expense Modal */}
        {showForm && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(44,36,32,0.4)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
            onClick={e => { if (e.target === e.currentTarget) setShowForm(false); }}>
            <div className="sheet" style={{ background: "#fff", borderRadius: "24px 24px 0 0", padding: "28px 20px 44px", width: "100%", maxWidth: 430, boxShadow: "0 -8px 40px rgba(44,36,32,0.12)" }}>
              <div style={{ width: 36, height: 4, background: "#E8E0D8", borderRadius: 2, margin: "0 auto 24px" }} />
              <div style={{ fontFamily: "DM Serif Display", fontSize: 22, color: "#2C2420", marginBottom: 22 }}>
                {editingId ? <>記録を<em style={{ color: "#B5755A" }}>編集</em></> : form.type === "income" ? <>入金を<em style={{ color: "#6B9E5A" }}>記録</em></> : <>新しい<em style={{ color: "#B5755A" }}>記録</em></>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ display: "flex", background: "#F7F3EE", borderRadius: 10, padding: 4 }}>
                  {[["expense", "支出"], ["income", "入金"]].map(([val, label]) => (
                    <button key={val} onClick={() => setForm({ ...form, type: val })} style={{
                      flex: 1, padding: "9px", border: "none", borderRadius: 8, cursor: "pointer",
                      fontFamily: "DM Sans", fontWeight: 600, fontSize: 14, transition: "all 0.2s",
                      background: form.type === val ? (val === "income" ? "#6B9E5A" : "#2C2420") : "transparent",
                      color: form.type === val ? "#fff" : "#9A8E86",
                    }}>{label}</button>
                  ))}
                </div>
                <div>
                  <label style={S.label}>金額（円）<span style={{ color: "#C4785A" }}>*</span></label>
                  <input style={S.input} type="text" inputMode="numeric" pattern="[0-9]*" placeholder="0" value={form.amount ? Number(form.amount).toLocaleString('ja-JP') : ''} onChange={e => setForm({ ...form, amount: e.target.value.replace(/[^0-9]/g, '') })} autoFocus />
                </div>
                <div>
                  <label style={S.label}>タイトル <span style={{ color: "#C8C0B8", fontWeight: 400, textTransform: "none", fontSize: 11 }}>— 空欄だと金額が入ります</span></label>
                  <input style={S.input} placeholder="例：ランチ" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} />
                </div>
                <div style={{ display: "flex", gap: 12 }}>
                  {form.type !== "income" && (
                    <div style={{ flex: 1 }}>
                      <label style={S.label}>カテゴリ</label>
                      <select style={S.input} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                        {categories.map(c => <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>)}
                      </select>
                    </div>
                  )}
                  <div style={{ flex: 1 }}>
                    <label style={S.label}>日付</label>
                    <input style={S.input} type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
                  </div>
                </div>
                <div>
                  <label style={S.label}>メモ（任意）</label>
                  <input style={S.input} placeholder="例：初めて行ったお店！" value={form.memo} onChange={e => setForm({ ...form, memo: e.target.value })} />
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                  <button onClick={() => setShowForm(false)} style={{ flex: 1, padding: "13px", borderRadius: 10, border: "1.5px solid #E8E0D8", background: "none", fontFamily: "DM Sans", fontWeight: 600, fontSize: 15, color: "#9A8E86", cursor: "pointer" }}>キャンセル</button>
                  <button onClick={submitForm} disabled={savingExpense || !form.amount} style={{ flex: 2, padding: "13px", borderRadius: 10, border: "none", background: "#2C2420", color: "#fff", fontFamily: "DM Sans", fontWeight: 600, fontSize: 15, cursor: "pointer", opacity: savingExpense || !form.amount ? 0.45 : 1, transition: "opacity 0.15s" }}>{savingExpense ? "保存中..." : editingId ? "更新する" : "記録する"}</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Category Modal */}
        {showCatForm && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(44,36,32,0.4)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
            onClick={e => { if (e.target === e.currentTarget) setShowCatForm(false); }}>
            <div className="sheet" style={{ background: "#fff", borderRadius: "24px 24px 0 0", width: "100%", maxWidth: 430, boxShadow: "0 -8px 40px rgba(44,36,32,0.12)", display: "flex", flexDirection: "column", maxHeight: "90vh" }}>
              <div style={{ padding: "28px 20px 0", flexShrink: 0 }}>
                <div style={{ width: 36, height: 4, background: "#E8E0D8", borderRadius: 2, margin: "0 auto 20px" }} />
                <div style={{ fontFamily: "DM Serif Display", fontSize: 22, color: "#2C2420", marginBottom: 18 }}>
                  {editingCatId ? <>カテゴリを<em style={{ color: "#B5755A" }}>編集</em></> : <>カテゴリを<em style={{ color: "#B5755A" }}>追加</em></>}
                </div>
              </div>
              <div style={{ overflowY: "auto", padding: "0 20px 44px", flex: 1 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "#F7F3EE", borderRadius: 12, border: "1px solid #E8E0D8" }}>
                    <div style={{ width: 44, height: 44, borderRadius: 12, background: `${catForm.color}22`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>{catForm.emoji}</div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 15, color: "#2C2420" }}>{catForm.label || "カテゴリ名"}</div>
                      <div style={{ fontSize: 12, color: catForm.color, fontWeight: 500, marginTop: 2 }}>プレビュー</div>
                    </div>
                  </div>
                  <div>
                    <label style={S.label}>カテゴリ名<span style={{ color: "#C4785A" }}>*</span></label>
                    <input style={S.input} placeholder="例：温泉" value={catForm.label} onChange={e => setCatForm({ ...catForm, label: e.target.value })} autoFocus />
                  </div>
                  {!editingCatId && (
                    <div>
                      <label htmlFor="category-position" style={S.label}>追加する位置</label>
                      <select id="category-position" style={S.input} value={newCategoryPosition} onChange={event => setNewCategoryPosition(event.target.value)}>
                        <option value="first">先頭（よく使うカテゴリ）</option>
                        <option value="last">末尾</option>
                      </select>
                    </div>
                  )}
                  <div>
                    <label style={S.label}>絵文字</label>
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      {EMOJI_GROUPS.map(group => (
                        <div key={group.label}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: "#9A8E86", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>{group.label}</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {group.emojis.map(em => (
                              <button key={em} onClick={() => setCatForm({ ...catForm, emoji: em })} style={{
                                width: 38, height: 38, borderRadius: 10, border: `2px solid ${catForm.emoji === em ? "#B5755A" : "#E8E0D8"}`,
                                background: catForm.emoji === em ? "#F0E6DF" : "#F7F3EE",
                                fontSize: 18, cursor: "pointer", transition: "all 0.15s",
                              }}>{em}</button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label style={S.label}>カラー</label>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {PALETTE.map(col => (
                        <button key={col} onClick={() => setCatForm({ ...catForm, color: col })} style={{
                          width: 32, height: 32, borderRadius: "50%", background: col,
                          border: `3px solid ${catForm.color === col ? "#2C2420" : "transparent"}`,
                          cursor: "pointer", transition: "border 0.15s",
                        }} />
                      ))}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                    <button onClick={() => setShowCatForm(false)} style={{ flex: 1, padding: "13px", borderRadius: 10, border: "1.5px solid #E8E0D8", background: "none", fontFamily: "DM Sans", fontWeight: 600, fontSize: 15, color: "#9A8E86", cursor: "pointer" }}>キャンセル</button>
                    <button onClick={submitCatForm} disabled={savingCategory || !catForm.label.trim()} style={{ flex: 2, padding: "13px", borderRadius: 10, border: "none", background: "#2C2420", color: "#fff", fontFamily: "DM Sans", fontWeight: 600, fontSize: 15, cursor: "pointer", opacity: savingCategory || !catForm.label.trim() ? 0.45 : 1, transition: "opacity 0.15s" }}>{savingCategory ? "保存中..." : editingCatId ? "更新する" : "追加する"}</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Recurring Expense Modal */}
        {showRecForm && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(44,36,32,0.4)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
            onClick={event => { if (event.target === event.currentTarget && !savingRecurring) setShowRecForm(false); }}>
            <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="recurring-modal-title" style={{ background: "#fff", borderRadius: "24px 24px 0 0", width: "100%", maxWidth: 430, maxHeight: "90dvh", display: "flex", flexDirection: "column", boxShadow: "0 -8px 40px rgba(44,36,32,0.12)" }}>
              <div style={{ padding: "28px 20px 0", flexShrink: 0 }}>
                <div style={{ width: 36, height: 4, background: "#E8E0D8", borderRadius: 2, margin: "0 auto 20px" }} />
                <div id="recurring-modal-title" style={{ fontFamily: "DM Serif Display", fontSize: 22, marginBottom: 18 }}>
                  定期支出を<em style={{ color: "#B5755A" }}>{editingRecId ? "編集" : "追加"}</em>
                </div>
              </div>
              <form onSubmit={event => { event.preventDefault(); submitRecForm(); }} style={{ overflowY: "auto", padding: "0 20px 44px", flex: 1 }}>
                <fieldset disabled={savingRecurring} style={{ border: "none", padding: 0, margin: 0, minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
                  <div>
                    <label htmlFor="recurring-title" style={S.label}>タイトル<span style={{ color: "#C4785A" }}>*</span></label>
                    <input id="recurring-title" style={S.input} placeholder="例：サブスク" value={recForm.title} onChange={event => setRecForm({ ...recForm, title: event.target.value })} required autoFocus />
                  </div>
                  <div>
                    <label htmlFor="recurring-amount" style={S.label}>金額（円）<span style={{ color: "#C4785A" }}>*</span></label>
                    <input id="recurring-amount" style={S.input} type="text" inputMode="numeric" placeholder="0" value={recForm.amount ? Number(recForm.amount).toLocaleString("ja-JP") : ""} onChange={event => setRecForm({ ...recForm, amount: event.target.value.replace(/[^0-9]/g, "") })} required />
                  </div>
                  <div>
                    <label htmlFor="recurring-category" style={S.label}>カテゴリ</label>
                    <select id="recurring-category" style={S.input} value={recForm.category} onChange={event => setRecForm({ ...recForm, category: event.target.value })}>
                      {categories.map(category => <option key={category.id} value={category.id}>{category.emoji} {category.label}</option>)}
                    </select>
                  </div>
                  <div style={{ display: "flex", gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="recurring-day" style={S.label}>計上日</label>
                      <select id="recurring-day" style={S.input} value={recForm.dayOfMonth} onChange={event => setRecForm({ ...recForm, dayOfMonth: Number(event.target.value) })}>
                        {Array.from({ length: 31 }, (_, index) => index + 1).map(day => <option key={day} value={day}>{day}日</option>)}
                      </select>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <label htmlFor="recurring-interval" style={S.label}>頻度</label>
                      <select id="recurring-interval" style={S.input} value={recForm.intervalMonths} onChange={event => setRecForm({ ...recForm, intervalMonths: Number(event.target.value) })}>
                        {INTERVAL_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label htmlFor="recurring-start" style={S.label}>開始月</label>
                    <input id="recurring-start" style={S.input} type="month" value={recForm.startMonth} onChange={event => setRecForm({ ...recForm, startMonth: event.target.value })} required />
                    <div style={{ marginTop: 6, fontSize: 11, color: "#9A8E86", lineHeight: 1.6 }}>過去の月を指定すると、その月からの未計上分も追加されます。</div>
                  </div>
                  <div>
                    <label htmlFor="recurring-memo" style={S.label}>メモ（任意）</label>
                    <input id="recurring-memo" style={S.input} value={recForm.memo} onChange={event => setRecForm({ ...recForm, memo: event.target.value })} placeholder="メモを入力..." />
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 10, border: `1.5px solid ${recForm.amountVaries ? "#D8C788" : "#E8E0D8"}`, background: recForm.amountVaries ? "#FAF4DF" : "transparent", cursor: "pointer" }}>
                    <input type="checkbox" checked={recForm.amountVaries} onChange={event => setRecForm({ ...recForm, amountVaries: event.target.checked })} style={{ width: 17, height: 17, accentColor: NEEDS_CONFIRM_COLOR, flexShrink: 0 }} />
                    <span style={{ fontSize: 13, lineHeight: 1.5 }}>金額が毎月変わる（計上後に金額を確認）</span>
                  </label>
                  <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                    <button type="button" onClick={() => setShowRecForm(false)} style={{ flex: 1, padding: 13, borderRadius: 10, border: "1.5px solid #E8E0D8", background: "none", fontFamily: "DM Sans", fontWeight: 600, fontSize: 15, color: "#9A8E86", cursor: "pointer" }}>キャンセル</button>
                    <button type="submit" disabled={!validRecForm || savingRecurring} style={{ flex: 2, padding: 13, borderRadius: 10, border: "none", background: "#2C2420", color: "#fff", fontFamily: "DM Sans", fontWeight: 600, fontSize: 15, cursor: "pointer", opacity: !validRecForm || savingRecurring ? 0.45 : 1 }}>{savingRecurring ? "保存中..." : editingRecId ? "更新する" : "追加する"}</button>
                  </div>
                </fieldset>
              </form>
            </div>
          </div>
        )}

        {/* Confirm Delete Modal */}
        {confirmDialog && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(44,36,32,0.4)", zIndex: 300, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
            onClick={e => { if (e.target === e.currentTarget) setConfirmDialog(null); }}>
            <div className="sheet" style={{ background: "#fff", borderRadius: "24px 24px 0 0", padding: "28px 20px 36px", width: "100%", maxWidth: 430, boxShadow: "0 -8px 40px rgba(44,36,32,0.12)" }}>
              <div style={{ width: 36, height: 4, background: "#E8E0D8", borderRadius: 2, margin: "0 auto 22px" }} />
              <div style={{ fontFamily: "DM Serif Display", fontSize: 22, color: "#2C2420", marginBottom: 14 }}>
                この{confirmDialog.kind === "category" ? "カテゴリ" : confirmDialog.kind === "recurring" ? "定期支出" : "記録"}を<em style={{ color: "#C4785A" }}>削除</em>しますか？
              </div>
              <div style={{ background: "#F7F3EE", borderRadius: 12, padding: "14px 16px", border: "1px solid #E8E0D8", marginBottom: 14 }}>
                <div style={{ fontWeight: 600, fontSize: 15, color: "#2C2420", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{confirmDialog.body}</div>
                <div style={{ fontSize: 12, color: "#9A8E86", marginTop: 4 }}>{confirmDialog.sub}</div>
              </div>
              <div style={{ fontSize: 12, color: "#9A8E86", marginBottom: 18, lineHeight: 1.7 }}>
                ✦ 削除すると元に戻せません
                {confirmDialog.kind === "recurring" && <><br />✦ 計上済みの記録は残ります</>}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setConfirmDialog(null)} style={{ flex: 1, padding: "13px", borderRadius: 10, border: "1.5px solid #E8E0D8", background: "none", fontFamily: "DM Sans", fontWeight: 600, fontSize: 15, color: "#9A8E86", cursor: "pointer" }}>キャンセル</button>
                <button onClick={() => { confirmDialog.onConfirm(); setConfirmDialog(null); }} style={{ flex: 1, padding: "13px", borderRadius: 10, border: "none", background: "#C4785A", color: "#fff", fontFamily: "DM Sans", fontWeight: 600, fontSize: 15, cursor: "pointer" }}>削除する</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
