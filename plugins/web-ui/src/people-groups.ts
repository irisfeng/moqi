export interface DirectoryPerson {
  principalId: string;
  displayName: string;
  department: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface PeopleGroup {
  department: string | null;
  people: DirectoryPerson[];
}

export function groupPeople(people: readonly DirectoryPerson[], query: string): PeopleGroup[] {
  const q = query.trim().toLowerCase();
  const digits = /^[\d\s()+-]+$/.test(q) ? q.replace(/\D/g, "") : "";
  const matches = (person: DirectoryPerson): boolean =>
    `${person.displayName} ${person.department ?? ""} ${person.email ?? ""} ${person.phone ?? ""}`
      .toLowerCase()
      .includes(q) ||
    (person.phone ?? "").replace(/\s/g, "").includes(q.replace(/\s/g, "")) ||
    (digits !== "" && (person.phone ?? "").replace(/\D/g, "").includes(digits));
  const shown = q ? people.filter(matches) : people;
  const groups = new Map<string | null, DirectoryPerson[]>();
  for (const person of shown) {
    const group = groups.get(person.department) ?? [];
    group.push(person);
    groups.set(person.department, group);
  }
  return [...groups.entries()]
    .map(([department, members]) => ({
      department,
      people: members.sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-CN")),
    }))
    .sort((a, b) => {
      if (a.department === null || b.department === null)
        return Number(a.department === null) - Number(b.department === null);
      return a.department.localeCompare(b.department, "zh-CN");
    });
}
