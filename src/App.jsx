import { useState, useEffect } from "react";
import {
  collection, doc, setDoc, deleteDoc,
  onSnapshot, query, orderBy
} from "firebase/firestore";
import { signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from "firebase/auth";
import { db, auth, googleProvider } from "./firebase";

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
const EMPTY_FORM = { title: "", amount: "", category: "food", memo: "", date: new Date().toISOString().slice(0, 10) };
const EMPTY_CAT_FORM = { label: "", emoji: "🍽", color: "#C4785A" };

// Firestore のコレクション名（二人で共有する固定ID）
const SHARED_ID = "shared";

export default function App() {
  const [user, setUser] = useState(undefined); // undefined=loading, null=未ログイン
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [tab, setTab] = useState("home");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [toast, setToast] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [filterCat, setFilterCat] = useState("all");
  const [showCatForm, setShowCatForm] = useState(false);
  const [editingCatId, setEditingCatId] = useState(null);
  const [catForm, setCatForm] = useState(EMPTY_CAT_FORM);

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
    if (!user) return;

    const expQ = query(collection(db, "expenses"), orderBy("date", "desc"));
    const unsubExp = onSnapshot(expQ, (snap) => {
      setExpenses(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    const unsubCat = onSnapshot(doc(db, "settings", SHARED_ID), (snap) => {
      if (snap.exists() && snap.data().categories) {
        setCategories(snap.data().categories);
      }
    });

    return () => { unsubExp(); unsubCat(); };
  }, [user]);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 1800); };

const login = () => {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIOS) {
    signInWithRedirect(auth, googleProvider).catch(console.error);
  } else {
    signInWithPopup(auth, googleProvider).catch(console.error);
  }
};
  const logout = () => signOut(auth);

  // 費用の保存・更新・削除
  const submitForm = async () => {
    if (!form.amount) return;
    const title = form.title || fmt(Number(form.amount));
    const data = { ...form, title, amount: Number(form.amount) };
    if (editingId) {
      await setDoc(doc(db, "expenses", editingId), data);
      showToast("✓ 更新しました");
    } else {
      const id = "exp_" + Date.now();
      await setDoc(doc(db, "expenses", id), data);
      showToast("✓ 記録しました");
    }
    setShowForm(false);
  };

  const delExpense = async (id) => {
    await deleteDoc(doc(db, "expenses", id));
    showToast("削除しました");
  };

  // カテゴリの保存・削除
  const submitCatForm = async () => {
    if (!catForm.label.trim()) return;
    let newCats;
    if (editingCatId) {
      newCats = categories.map(c => c.id === editingCatId ? { ...c, ...catForm } : c);
      showToast("✓ カテゴリを更新しました");
    } else {
      newCats = [...categories, { id: "cat_" + Date.now(), ...catForm }];
      showToast("✓ カテゴリを追加しました");
    }
    await setDoc(doc(db, "settings", SHARED_ID), { categories: newCats });
    setShowCatForm(false);
  };

  const delCategory = async (id) => {
    if (expenses.some(e => e.category === id)) {
      showToast("使用中のカテゴリは削除できません");
      return;
    }
    const newCats = categories.filter(c => c.id !== id);
    await setDoc(doc(db, "settings", SHARED_ID), { categories: newCats });
    showToast("カテゴリを削除しました");
  };

  const openAdd = () => { setEditingId(null); setForm(EMPTY_FORM); setShowForm(true); };
  const openEdit = (e) => {
    setEditingId(e.id);
    setForm({ title: e.title, amount: String(e.amount), category: e.category, memo: e.memo || "", date: e.date });
    setShowForm(true);
  };
  const openAddCat = () => { setEditingCatId(null); setCatForm(EMPTY_CAT_FORM); setShowCatForm(true); };
  const openEditCat = (c) => { setEditingCatId(c.id); setCatForm({ label: c.label, emoji: c.emoji, color: c.color }); setShowCatForm(true); };

  const cat = (id) => categories.find(c => c.id === id) || { emoji: "✦", label: "不明", color: "#888" };
  const filtered = filterCat === "all" ? expenses : expenses.filter(e => e.category === filterCat);
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  const byCategory = categories.map(c => ({
    ...c, total: expenses.filter(e => e.category === c.id).reduce((s, e) => s + e.amount, 0),
  })).filter(c => c.total > 0).sort((a, b) => b.total - a.total);
  const grouped = filtered.reduce((acc, e) => {
    const m = e.date.slice(0, 7);
    if (!acc[m]) acc[m] = [];
    acc[m].push(e);
    return acc;
  }, {});

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
          <div style={{ fontSize: 13, color: "#9A8E86", marginBottom: 40, fontFamily: "DM Sans" }}>ふたりの思い出帳</div>
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
        <div style={{ padding: "36px 24px 24px", borderBottom: "1px solid #E8E0D8" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontFamily: "DM Serif Display", fontSize: 28, color: "#2C2420", lineHeight: 1.15 }}>
                Date<br /><em style={{ color: "#B5755A" }}>Wallet</em>
              </div>
              <div style={{ fontSize: 12, color: "#9A8E86", marginTop: 6, fontWeight: 500, letterSpacing: "0.04em" }}>ふたりの思い出帳</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, color: "#9A8E86", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>Total</div>
              <div style={{ fontFamily: "DM Serif Display", fontSize: 30, color: "#2C2420" }}>{fmt(total)}</div>
              <button onClick={logout} style={{ background: "none", border: "none", fontSize: 11, color: "#B8B0A8", cursor: "pointer", marginTop: 4, fontFamily: "DM Sans" }}>
                ログアウト
              </button>
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
            }}>{label}</button>
          ))}
        </div>

        {/* HOME */}
        {tab === "home" && (
          <div>
            <div style={{ padding: "12px 16px 12px", display: "flex", gap: 6, overflowX: "auto", borderBottom: "1px solid #E8E0D8" }}>
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
                <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 6 }}>まだ記録がありません</div>
                <div style={{ fontSize: 13 }}>下のボタンから追加してみてください</div>
              </div>
            ) : (
              <div style={{ padding: "8px 0" }}>
                {Object.entries(grouped).sort((a, b) => b[0].localeCompare(a[0])).map(([month, items]) => (
                  <div key={month}>
                    <div style={{ padding: "10px 20px 6px", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "#9A8E86", textTransform: "uppercase", display: "flex", justifyContent: "space-between" }}>
                      <span>{month.replace("-", "年") + "月"}</span>
                      <span>{fmt(items.reduce((s, e) => s + e.amount, 0))}</span>
                    </div>
                    {items.map((e, i) => (
                      <div key={e.id} className="fade-in" style={{ margin: "0 12px 6px", background: "#fff", borderRadius: 14, padding: "14px 16px", border: "1px solid #E8E0D8", display: "flex", alignItems: "center", gap: 14, animationDelay: `${i * 0.04}s` }}>
                        <div style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0, background: `${cat(e.category)?.color}18`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>
                          {cat(e.category)?.emoji}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 15, color: "#2C2420", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title}</div>
                          <div style={{ fontSize: 12, color: "#9A8E86", marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <span>{e.date.slice(5).replace("-", "/")}</span>
                            <span style={{ color: cat(e.category)?.color, fontWeight: 500 }}>{cat(e.category)?.label}</span>
                            {e.memo && <span>— {e.memo}</span>}
                          </div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontFamily: "DM Serif Display", fontSize: 17, color: "#2C2420" }}>{fmt(e.amount)}</div>
                          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
                            <button className="row-btn" style={{ color: "#B5755A" }} onClick={() => openEdit(e)}>編集</button>
                            <span style={{ color: "#E8E0D8", fontSize: 12 }}>|</span>
                            <button className="row-btn" style={{ color: "#D0C8C0" }}
                              onMouseEnter={ev => ev.target.style.color = "#C4785A"}
                              onMouseLeave={ev => ev.target.style.color = "#D0C8C0"}
                              onClick={() => delExpense(e.id)}>削除</button>
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
                  {[["合計件数", `${expenses.length} 件`], ["合計金額", fmt(total)], ...(expenses.length > 0 ? [["1回あたり平均", fmt(Math.round(total / expenses.length))]] : [])].map(([k, v], i, arr) => (
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
          </div>
        )}

        {/* SETTINGS */}
        {tab === "settings" && (
          <div style={{ padding: "20px 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontFamily: "DM Serif Display", fontSize: 20, color: "#2C2420" }}>カテゴリ <em style={{ color: "#B5755A" }}>管理</em></div>
              <button onClick={openAddCat} style={{ background: "#2C2420", color: "#fff", border: "none", borderRadius: 50, padding: "8px 18px", fontFamily: "DM Sans", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>+ 追加</button>
            </div>
            {categories.map((c, i) => {
              const usedCount = expenses.filter(e => e.category === c.id).length;
              return (
                <div key={c.id} className="fade-in" style={{ ...S.card, display: "flex", alignItems: "center", gap: 14, animationDelay: `${i * 0.04}s` }}>
                  <div style={{ width: 42, height: 42, borderRadius: 12, background: `${c.color}22`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>{c.emoji}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 15, color: "#2C2420" }}>{c.label}</div>
                    <div style={{ fontSize: 12, color: "#9A8E86", marginTop: 2 }}>{usedCount > 0 ? `${usedCount}件の記録` : "未使用"}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: c.color, marginRight: 8 }} />
                    <button className="row-btn" style={{ color: "#B5755A" }} onClick={() => openEditCat(c)}>編集</button>
                    <span style={{ color: "#E8E0D8", fontSize: 12, margin: "0 2px" }}>|</span>
                    <button className="row-btn" style={{ color: "#D0C8C0" }}
                      onMouseEnter={ev => { if (usedCount === 0) ev.target.style.color = "#C4785A"; }}
                      onMouseLeave={ev => ev.target.style.color = "#D0C8C0"}
                      onClick={() => delCategory(c.id)}>削除</button>
                  </div>
                </div>
              );
            })}
            <div style={{ marginTop: 16, padding: "14px 16px", background: "#F0E6DF", borderRadius: 14, border: "1px solid rgba(181,117,90,0.2)", fontSize: 12, color: "#9A8E86", lineHeight: 1.7 }}>
              ✦ 使用中のカテゴリは削除できません<br />
              ✦ カテゴリ名・絵文字・カラーを自由に変更できます
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
            <span style={{ fontSize: 18, lineHeight: 1 }}>+</span> 費用を記録する
          </button>
        )}

        {/* Expense Modal */}
        {showForm && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(44,36,32,0.4)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
            onClick={e => { if (e.target === e.currentTarget) setShowForm(false); }}>
            <div className="sheet" style={{ background: "#fff", borderRadius: "24px 24px 0 0", padding: "28px 20px 44px", width: "100%", maxWidth: 430, boxShadow: "0 -8px 40px rgba(44,36,32,0.12)" }}>
              <div style={{ width: 36, height: 4, background: "#E8E0D8", borderRadius: 2, margin: "0 auto 24px" }} />
              <div style={{ fontFamily: "DM Serif Display", fontSize: 22, color: "#2C2420", marginBottom: 22 }}>
                {editingId ? <>記録を<em style={{ color: "#B5755A" }}>編集</em></> : <>新しい<em style={{ color: "#B5755A" }}>記録</em></>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <label style={S.label}>金額（円）<span style={{ color: "#C4785A" }}>*</span></label>
                  <input style={S.input} type="number" placeholder="0" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} autoFocus />
                </div>
                <div>
                  <label style={S.label}>タイトル <span style={{ color: "#C8C0B8", fontWeight: 400, textTransform: "none", fontSize: 11 }}>— 空欄だと金額が入ります</span></label>
                  <input style={S.input} placeholder="例：ランチ" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} />
                </div>
                <div style={{ display: "flex", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <label style={S.label}>カテゴリ</label>
                    <select style={S.input} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                      {categories.map(c => <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>)}
                    </select>
                  </div>
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
                  <button onClick={submitForm} style={{ flex: 2, padding: "13px", borderRadius: 10, border: "none", background: "#2C2420", color: "#fff", fontFamily: "DM Sans", fontWeight: 600, fontSize: 15, cursor: "pointer", opacity: !form.amount ? 0.45 : 1, transition: "opacity 0.15s" }}>{editingId ? "更新する" : "記録する"}</button>
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
                    <button onClick={submitCatForm} style={{ flex: 2, padding: "13px", borderRadius: 10, border: "none", background: "#2C2420", color: "#fff", fontFamily: "DM Sans", fontWeight: 600, fontSize: 15, cursor: "pointer", opacity: !catForm.label.trim() ? 0.45 : 1, transition: "opacity 0.15s" }}>{editingCatId ? "更新する" : "追加する"}</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
