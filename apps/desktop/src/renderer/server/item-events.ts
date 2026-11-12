import type { Item, ServerEvent } from "@dodocode/protocol";

export type ItemEvent = Extract<ServerEvent, { type: "item" | "item.append" }>;

/**
 * Applies item events, in order, to the items held. Returns the items they changed, whole. An
 * append adds to an item from earlier in the same events, or to the one held; an append for an
 * item it can't find, or to a field the item lacks, changes nothing.
 */
export function applyItemEvents(
  held: ReadonlyMap<string, Item>,
  events: readonly ItemEvent[],
): Map<string, Item> {
  const changed = new Map<string, Item>();
  for (const event of events) {
    if (event.type === "item") {
      changed.set(event.item.id, event.item);
      continue;
    }
    const item = changed.get(event.itemId) ?? held.get(event.itemId);
    if (!item) continue;
    const current = (item as unknown as Record<string, unknown>)[event.field];
    if (typeof current !== "string") continue;
    changed.set(item.id, { ...item, [event.field]: current + event.text } as Item);
  }
  return changed;
}
