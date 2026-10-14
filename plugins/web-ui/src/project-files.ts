export interface ProjectFile {
  name: string;
  delivered?: boolean;
  session?: { id: string; title: string | null };
}

export function splitProjectFiles<T extends ProjectFile>(
  files: readonly T[],
  query: string,
): { deliverables: T[]; working: T[] } {
  const q = query.trim().toLowerCase();
  const shown = q ? files.filter((f) => `${f.name} ${f.session?.title ?? ""}`.toLowerCase().includes(q)) : files;
  return {
    deliverables: shown.filter((f) => f.delivered === true),
    working: shown.filter((f) => f.delivered !== true),
  };
}
