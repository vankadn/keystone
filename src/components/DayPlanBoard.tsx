import { useState } from 'react';
import type { ReactNode } from 'react';
import { DndContext, PointerSensor, closestCenter, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { DaySection, PlanItemType } from '../lib/types';

// Groundwork for a later calendar/specific-time view (Phase 11) — this is
// just the section/ordering list UI, not a calendar grid. Shared by Today
// (same-day adjustments) and Plan Tomorrow (the primary place arrangement
// happens); each page supplies its own per-item-type row rendering via
// `renderItem` so this component only owns drag mechanics + grouping
// display, never what a habit/task/class row looks like or what actions
// it has (that stays page-specific, per the "UI has no business logic of
// its own" / "provider has no business logic" split — this component has
// none either, it just moves things and reports where they landed).

const SECTION_PREFIX = 'section:';

export interface PlanBoardItem {
  itemType: PlanItemType;
  itemId: string;
  itemSortOrder: number;
}

function draggableId(item: PlanBoardItem) {
  return `${item.itemType}:${item.itemId}`;
}

function splitDraggableId(id: string): [PlanItemType, string] {
  const sep = id.indexOf(':');
  return [id.slice(0, sep) as PlanItemType, id.slice(sep + 1)];
}

function SortableRow({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

// A section's item list is both a SortableContext (item-to-item reorder)
// and its own droppable (so an empty section, or dropping below the last
// item, has somewhere to land — a bare SortableContext with zero items
// has no drop target of its own).
function SectionDropZone({ sectionId, children }: { sectionId: string; children: ReactNode }) {
  const { setNodeRef } = useDroppable({ id: `${SECTION_PREFIX}${sectionId}` });
  return (
    <div ref={setNodeRef} className="min-h-10 space-y-2">
      {children}
    </div>
  );
}

export function DayPlanBoard<T extends PlanBoardItem>({
  grouped,
  onMove,
  renderItem,
}: {
  grouped: { section: DaySection; items: T[] }[];
  onMove: (itemType: PlanItemType, itemId: string, sectionId: string, itemSortOrder: number) => void;
  renderItem: (item: T) => ReactNode;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // Habits have a fixed home section (Phase 11 amendment) — Tasks/Classes
  // don't. Tracked here (not derived per-render) so the "other sections
  // dim while dragging a habit" cue and the handleDragEnd rejection agree
  // on the same home section for the whole gesture, even if `grouped`
  // itself re-renders mid-drag.
  const [draggingHabitHomeSectionId, setDraggingHabitHomeSectionId] = useState<string | null>(null);

  function homeSectionIdFor(id: string) {
    return grouped.find((g) => g.items.some((it) => draggableId(it) === id))?.section.sectionId ?? null;
  }

  function handleDragStart(event: DragStartEvent) {
    const activeId = String(event.active.id);
    const [activeType] = splitDraggableId(activeId);
    setDraggingHabitHomeSectionId(activeType === 'habit' ? homeSectionIdFor(activeId) : null);
  }

  function handleDragCancel() {
    setDraggingHabitHomeSectionId(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setDraggingHabitHomeSectionId(null);
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    const [activeType, activeItemId] = splitDraggableId(activeId);

    let targetSectionId: string;
    let targetItems: PlanBoardItem[];
    let insertIndex: number;

    if (overId.startsWith(SECTION_PREFIX)) {
      targetSectionId = overId.slice(SECTION_PREFIX.length);
      const targetGroup = grouped.find((g) => g.section.sectionId === targetSectionId);
      targetItems = (targetGroup?.items ?? []).filter((it) => draggableId(it) !== activeId);
      insertIndex = targetItems.length;
    } else {
      const targetGroup = grouped.find((g) => g.items.some((it) => draggableId(it) === overId));
      if (!targetGroup) return;
      targetSectionId = targetGroup.section.sectionId;
      targetItems = targetGroup.items.filter((it) => draggableId(it) !== activeId);
      const overIndex = targetItems.findIndex((it) => draggableId(it) === overId);
      insertIndex = overIndex === -1 ? targetItems.length : overIndex;
    }

    // Habits can't leave their home section — reorder-within-section only.
    // The section a habit is currently grouped under is already its fixed
    // home (groupItemsBySections enforces that), so rejecting any target
    // other than that is enough; no separate lookup of habits.sectionId
    // needed here.
    if (activeType === 'habit' && targetSectionId !== homeSectionIdFor(activeId)) {
      return;
    }

    // Fractional sort key: only the moved item is written, siblings never
    // get renumbered/rewritten. Keeps every drag to exactly one
    // upsertDayPlanItem call instead of one per item in the section —
    // cheap in Sheets API write-quota terms, which matters after already
    // hitting a read-quota 429 once this project (see CLAUDE.md's
    // Provider section).
    const before = targetItems[insertIndex - 1];
    const after = targetItems[insertIndex];
    const newSortOrder =
      before && after
        ? (before.itemSortOrder + after.itemSortOrder) / 2
        : before
          ? before.itemSortOrder + 1
          : after
            ? after.itemSortOrder - 1
            : 0;

    onMove(activeType, activeItemId, targetSectionId, newSortOrder);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="space-y-4">
        {grouped.map(({ section, items }) => {
          const locked = draggingHabitHomeSectionId !== null && draggingHabitHomeSectionId !== section.sectionId;
          return (
            <Card key={section.sectionId} className={cn(locked && 'opacity-50 transition-opacity')}>
              <CardHeader>
                <CardTitle>{section.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <SortableContext items={items.map(draggableId)} strategy={verticalListSortingStrategy}>
                  <SectionDropZone sectionId={section.sectionId}>
                    {items.length === 0 && (
                      <p className="text-sm text-muted-foreground">Nothing here — drag an item in.</p>
                    )}
                    {items.map((item) => (
                      <SortableRow key={draggableId(item)} id={draggableId(item)}>
                        {renderItem(item)}
                      </SortableRow>
                    ))}
                  </SectionDropZone>
                </SortableContext>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </DndContext>
  );
}
