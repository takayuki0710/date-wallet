import { useRef, useState } from "react";
import {
  DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor,
  closestCenter, useSensor, useSensors,
} from "@dnd-kit/core";
import {
  SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { categoryDragMove, placeCategory } from "./categoryOrder.js";

const verticalOnly = ({ transform }) => ({ ...transform, x: 0 });
const cardStyle = {
  background: "#fff", borderRadius: 14, padding: "14px 16px", marginBottom: 6,
  border: "1px solid #E8E0D8", display: "flex", alignItems: "center", gap: 12,
};

function CategoryContent({ category, usedCount, recurringCount }) {
  return <>
    <span aria-hidden="true" style={{ fontSize: 21, color: "#B8B0A8", flexShrink: 0 }}>⠿</span>
    <div style={{ width: 42, height: 42, borderRadius: 12, background: `${category.color}22`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>{category.emoji}</div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontWeight: 600, fontSize: 15, color: "#2C2420", overflowWrap: "anywhere" }}>{category.label}</div>
      <div style={{ fontSize: 12, color: "#9A8E86", marginTop: 2 }}>{usedCount > 0 ? `${usedCount}件の記録` : recurringCount > 0 ? "定期支出で使用中" : "未使用"}</div>
    </div>
  </>;
}

function SortableCategory({ category, usedCount, recurringCount, disabled, onEdit, onDelete }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: category.id, disabled });
  return (
    <div ref={setNodeRef} data-category-id={category.id} style={{
      ...cardStyle, transform: CSS.Transform.toString(transform), transition,
      opacity: isDragging ? 0.25 : 1,
    }}>
      <div ref={setActivatorNodeRef} {...attributes} {...listeners}
        aria-label={`${category.label}を並べ替え`} aria-roledescription="並べ替え可能なカテゴリ"
        onContextMenu={event => event.preventDefault()}
        style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0,
          cursor: disabled ? "default" : "grab", touchAction: "manipulation", userSelect: "none", WebkitTouchCallout: "none" }}>
        <CategoryContent category={category} usedCount={usedCount} recurringCount={recurringCount} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <button className="row-btn" disabled={disabled} style={{ color: "#B5755A" }} onClick={() => onEdit(category)}>編集</button>
        <span style={{ color: "#E8E0D8", fontSize: 12 }}>|</span>
        <button className="row-btn" disabled={disabled} style={{ color: usedCount || recurringCount ? "#D0C8C0" : "#9A8E86" }} onClick={() => onDelete(category)}>削除</button>
      </div>
    </div>
  );
}

export default function CategoryList({ categories, expenses, recurringItems, onMove, onEdit, onDelete }) {
  const [activeId, setActiveId] = useState(null);
  const [pendingMove, setPendingMove] = useState(null);
  const saving = useRef(false);
  const sensors = useSensors(
    useSensor(TouchSensor, { activationConstraint: { delay: 350, tolerance: 8 } }),
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const displayed = pendingMove ? placeCategory(categories, pendingMove) || categories : categories;
  const active = categories.find(category => category.id === activeId);
  const counts = category => ({
    usedCount: expenses.filter(expense => expense.category === category.id).length,
    recurringCount: recurringItems.filter(item => item.category === category.id).length,
  });
  const name = id => categories.find(category => category.id === id)?.label || "カテゴリ";

  const finishDrag = async ({ active, over }) => {
    setActiveId(null);
    if (saving.current || !over) return;
    const move = categoryDragMove(categories, active.id, over.id);
    if (!move) return;
    saving.current = true;
    setPendingMove(move);
    try { await onMove(move); }
    finally { saving.current = false; setPendingMove(null); }
  };

  return (
    <>
      <div style={{ fontSize: 12, color: "#9A8E86", marginBottom: 12 }}>カテゴリ名を長押しして、そのまま上下に移動</div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[verticalOnly]}
        onDragStart={({ active }) => setActiveId(active.id)} onDragEnd={finishDrag} onDragCancel={() => setActiveId(null)}
        accessibility={{
          screenReaderInstructions: { draggable: "スペースキーでカテゴリを選び、上下の矢印キーで移動します。もう一度スペースキーで確定、Escapeキーで取り消します。" },
          announcements: {
            onDragStart: ({ active }) => `${name(active.id)}の移動を開始しました。`,
            onDragOver: ({ active, over }) => over ? `${name(active.id)}を${name(over.id)}の位置へ移動しています。` : undefined,
            onDragEnd: ({ active, over }) => over && active.id !== over.id ? `${name(active.id)}の並び順を変更します。` : "並び順は変更していません。",
            onDragCancel: () => "並べ替えを取り消しました。",
          },
        }}>
        <SortableContext items={displayed.map(category => category.id)} strategy={verticalListSortingStrategy}>
          {displayed.map(category => <SortableCategory key={category.id} category={category} {...counts(category)}
            disabled={!!pendingMove} onEdit={onEdit} onDelete={onDelete} />)}
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {active ? <div aria-hidden="true" style={{ ...cardStyle, marginBottom: 0, borderColor: "#B5755A", boxShadow: "0 8px 24px rgba(44,36,32,0.2)", cursor: "grabbing" }}>
            <CategoryContent category={active} {...counts(active)} />
          </div> : null}
        </DragOverlay>
      </DndContext>
      {pendingMove && <div role="status" style={{ fontSize: 12, color: "#9A8E86", marginTop: 8 }}>並び順を保存中...</div>}
    </>
  );
}
