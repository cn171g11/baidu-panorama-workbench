import { displaySourceIsHidden } from './hidden-flag.js';

const CATEGORIES = Object.freeze(["regular", "hidden", "time-machine", "unknown", "blue"]);

function categoryFor(row) {
  if (!row || typeof row !== "object") return "unknown";
  const extras = Array.isArray(row) ? row[9] : row.extras || row;
  if (extras?.blueDot === true || row.blueDot === true) return "blue";
  const sourceType = row.sourceType ?? extras?.sourceType;
  // Confirmed overrides already carry their resolved category and no true hidden flag.
  // A source label alone must not outrank the same record's literal visibility marker.
  if (displaySourceIsHidden(row, extras)) return "hidden";
  if (sourceType === "time-machine") return "time-machine";
  if (sourceType === "hidden" || sourceType === "unknown") return "unknown";
  return "regular";
}

function countCategories(rows) {
  const counts = { regular: 0, hidden: 0, timeMachine: 0, unknown: 0, blue: 0, total: 0 };
  if (!Array.isArray(rows)) return counts;
  for (const row of rows) { const category = categoryFor(row); counts[category === "time-machine" ? "timeMachine" : category]++; counts.total++; }
  return counts;
}

export { CATEGORIES, categoryFor, countCategories };
