import type { EssayStructure } from "./studio-types";

/** A source as far as criteria mapping cares (supports text is enough). */
interface SupportsLike {
  supports?: string;
}

export interface SourceCriteria {
  /** Criterion names, e.g. ["Criterion B"]. Empty for general background. */
  criteria: string[];
  /** Strand labels, e.g. ["strand i"]. */
  strands: string[];
  /** True when the source isn't tied to any outline section. */
  general: boolean;
}

export interface CriteriaRow {
  name: string;
  strands: string[];
  sections: string[];
  /** Indexes into the sources array. */
  sourceIndexes: number[];
}

/** Match a source's supports text back to outline sections by heading. */
function matchingSections(
  supports: string | undefined,
  structure: EssayStructure | null
): EssayStructure["sections"] {
  if (!structure || !supports) return [];
  return structure.sections.filter((s) => s.heading && supports.includes(s.heading));
}

/** Which criteria (and strands) a source serves, via its outline sections. */
export function criteriaForSource(
  source: SupportsLike,
  structure: EssayStructure | null
): SourceCriteria {
  const secs = matchingSections(source.supports, structure);
  if (secs.length === 0) return { criteria: [], strands: [], general: true };
  const criteria: string[] = [];
  const strands: string[] = [];
  for (const sec of secs) {
    for (const p of sec.paragraphs) {
      if (p.criterion && !criteria.includes(p.criterion)) criteria.push(p.criterion);
      if (p.strand && !strands.includes(p.strand)) strands.push(p.strand);
    }
  }
  return { criteria, strands, general: false };
}

/** One row per criterion: its strands, outline sections, and supporting source count. */
export function buildCriteriaMap(
  structure: EssayStructure | null,
  sources: SupportsLike[]
): CriteriaRow[] {
  if (!structure) return [];
  const rows = new Map<string, { strands: Set<string>; sections: Set<string>; sourceIndexes: Set<number> }>();
  const row = (name: string) => {
    let r = rows.get(name);
    if (!r) {
      r = { strands: new Set(), sections: new Set(), sourceIndexes: new Set() };
      rows.set(name, r);
    }
    return r;
  };
  for (const sec of structure.sections) {
    for (const p of sec.paragraphs) {
      if (!p.criterion) continue;
      const r = row(p.criterion);
      if (p.strand) r.strands.add(p.strand);
      if (sec.heading) r.sections.add(sec.heading);
    }
  }
  sources.forEach((s, i) => {
    for (const c of criteriaForSource(s, structure).criteria) row(c).sourceIndexes.add(i);
  });
  return [...rows.entries()].map(([name, r]) => ({
    name,
    strands: [...r.strands],
    sections: [...r.sections],
    sourceIndexes: [...r.sourceIndexes],
  }));
}
