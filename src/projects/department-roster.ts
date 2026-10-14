export interface RosterEntry {
  principalId: string;
  displayName: string;
  department: string | null;
  eligibleFrom: number | null;
  eligibleTo: number | null;
  isTest: boolean;
}

function onRosterNow(entry: RosterEntry, now: number): boolean {
  return (
    !entry.isTest &&
    Boolean(entry.department) &&
    (entry.eligibleFrom === null || entry.eligibleFrom <= now) &&
    (entry.eligibleTo === null || now < entry.eligibleTo)
  );
}

export function departmentNames(roster: readonly RosterEntry[], now: number): string[] {
  const names = new Set<string>();
  for (const entry of roster) if (onRosterNow(entry, now)) names.add(entry.department!);
  return [...names].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export function departmentMembers(roster: readonly RosterEntry[], department: string, now: number): RosterEntry[] {
  return roster
    .filter((entry) => onRosterNow(entry, now) && entry.department === department)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-CN"));
}

export function departmentByPerson(roster: readonly RosterEntry[], now: number): Map<string, string> {
  const departments = new Map<string, string>();
  for (const entry of roster) if (onRosterNow(entry, now)) departments.set(entry.principalId, entry.department!);
  return departments;
}
