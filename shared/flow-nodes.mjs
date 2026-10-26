// Generated graphs contain domain data, not React Flow's measurements. Dropping
// those measurements makes unchanged nodes invisible until the next resize pass.
// The caller must also apply onNodesChange so measurements and drag completion
// remain in the local node state.
export function reconcileFlowNodes(previous, incoming) {
  const byId = new Map(previous.map((node) => [node.id, node]));
  return incoming.map((node) => {
    const current = byId.get(node.id);
    if (!current || current.type !== node.type) return node;

    const next = { ...node };
    if (!node.measured && current.measured) next.measured = current.measured;
    if (current.dragging) {
      // A Docker refresh may arrive between two pointer events. It must update
      // the service status without moving the equipment back under the cursor.
      next.position = current.position;
      next.dragging = true;
    } else if (node.dragging === undefined && current.dragging !== undefined) {
      next.dragging = current.dragging;
    }
    return next;
  });
}
