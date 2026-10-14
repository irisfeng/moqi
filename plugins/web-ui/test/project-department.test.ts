import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { departmentSummary } from "../src/project-department.ts";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const people = (count: number) =>
  Array.from({ length: count }, (_value, index) => ({ principalId: `p${index}`, displayName: `Person ${index}` }));

test("the preview says how many are new and how many are already in the project", () => {
  assert.equal(
    departmentSummary({ members: people(3), alreadyIn: 2 }),
    "3 people will be added. 2 are already in the project.",
  );
  assert.equal(departmentSummary({ members: people(4), alreadyIn: 0 }), "4 people will be added.");
  assert.equal(
    departmentSummary({ members: [], alreadyIn: 5 }),
    "Everyone in this department is already in the project.",
  );
  assert.equal(departmentSummary({ members: [], alreadyIn: 0 }), "Nobody in this department can be added.");
});

test("only the owner is offered the department picker, and confirming sends the previewed people", () => {
  const contexts = read("../src/contexts.ts");
  assert.match(
    contexts,
    /pickerOpen && isProjectOwner\(context\) && !appState\.me\?\.impersonatedBy\s+\? departmentPicker\(context\.project!\.id, drawContexts/,
  );
  const picker = read("../src/project-department.ts");
  assert.match(picker, /memberIds: preview\.members\.map\(\(m\) => m\.principalId\)/);
  assert.match(picker, /Only the people listed now are added\./);
});
