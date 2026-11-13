const CATEGORIES = Object.freeze(["regular", "hidden", "time-machine", "unknown"]);

function categoryFor(row) {
  if (!row || typeof row !== "object") return "unknown";
  const extras = Array.isArray(row) ? row[9] : row.extras || row;
  const sourceType = row.sourceType ?? extras?.sourceType;
  if (sourceType === "time-machine") return "time-machine";
  if (sourceType === "hidden" || row.isHidden === true || extras?.isHidden === true) return "hidden";
  if (sourceType === "unknown") return "unknown";
  return "regular";
}

function countCategories(rows) {
  const counts = { regular: 0, hidden: 0, timeMachine: 0, unknown: 0, total: 0 };
  if (!Array.isArray(rows)) return counts;
  for (const row of rows) { const category = categoryFor(row); counts[category === "time-machine" ? "timeMachine" : category]++; counts.total++; }
  return counts;
}

export { CATEGORIES, categoryFor, countCategories };
