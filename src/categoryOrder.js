export const categoryDragMove = (categories, id, anchorId) => {
  const from = categories.findIndex(category => category.id === id);
  const to = categories.findIndex(category => category.id === anchorId);
  if (from < 0 || to < 0 || from === to) return null;
  return { id, anchorId, side: from < to ? "after" : "before" };
};

// 移動した一件だけを、最新の一覧の指定カテゴリの前後へ挿入します。
export const placeCategory = (categories, { id, anchorId, side }) => {
  if (!["before", "after"].includes(side)) return null;
  const category = categories.find(item => item.id === id);
  if (!category || !categories.some(item => item.id === anchorId)) return null;
  if (id === anchorId) return categories;
  const next = categories.filter(item => item.id !== id);
  const index = next.findIndex(item => item.id === anchorId);
  next.splice(index + (side === "after" ? 1 : 0), 0, category);
  return next;
};
