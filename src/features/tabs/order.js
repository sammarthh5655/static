/**
 * The tab strip's two rules about order, applied to any list of tab ids.
 *
 * 1. Pinned tabs come first, in the order they were pinned - they are the
 *    small squares at the far left, before every other tab and group.
 * 2. A group's tabs sit together. A group lives where its first tab is, and
 *    its other tabs gather behind that one, keeping their order.
 *
 * Everything else keeps its place: this is stable, so applying it to an order
 * that already follows the rules changes nothing. Ids with no tab are dropped.
 *
 * `get(id)` returns the tab record ({ pinned, groupId }) or nothing.
 */
function tidyOrder(order, get) {
  const pinned = [];
  const rest = [];
  for (const id of order) {
    const tab = get(id);
    if (tab) (tab.pinned ? pinned : rest).push(id);
  }
  const out = [...new Set(pinned)];
  const placed = new Set(out);
  for (const id of rest) {
    if (placed.has(id)) continue;
    const groupId = get(id).groupId;
    const members = groupId ? rest.filter((other) => !placed.has(other) && get(other).groupId === groupId) : [id];
    for (const member of members) { out.push(member); placed.add(member); }
  }
  return out;
}

module.exports = { tidyOrder };
