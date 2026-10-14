import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { groupPeople } from "../src/people-groups.ts";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const person = (displayName: string, department: string | null) => ({
  principalId: displayName.toLowerCase(),
  displayName,
  department,
});
const people = [
  person("Wei", "Sales"),
  person("Ann", "Sales"),
  person("Dee", null),
  person("Bo", "Finance"),
  person("Carl", null),
];
const shape = (groups: ReturnType<typeof groupPeople>) =>
  groups.map((group) => [group.department, group.people.map((member) => member.displayName)]);

test("people are grouped by department, names in order, with the unassigned last", () => {
  assert.deepEqual(shape(groupPeople(people, "")), [
    ["Finance", ["Bo"]],
    ["Sales", ["Ann", "Wei"]],
    [null, ["Carl", "Dee"]],
  ]);
});

test("search matches a name or a department, ignoring case", () => {
  assert.deepEqual(shape(groupPeople(people, " sales ")), [["Sales", ["Ann", "Wei"]]]);
  assert.deepEqual(shape(groupPeople(people, "DEE")), [[null, ["Dee"]]]);
  assert.deepEqual(groupPeople(people, "nobody-like-this"), []);
});

test("search also matches an email, or a phone number by its digits alone", () => {
  const contacts = [
    { ...person("Wei", "Sales"), email: "wei@example.test", phone: "0123-0123 4567 转 806" },
    { ...person("Ann", "Sales"), email: "ann@example.test", phone: null },
  ];
  assert.deepEqual(shape(groupPeople(contacts, "WEI@EXAMPLE")), [["Sales", ["Wei"]]]);
  assert.deepEqual(shape(groupPeople(contacts, "01234567")), [["Sales", ["Wei"]]]);
  assert.deepEqual(shape(groupPeople(contacts, "0123-4567")), [["Sales", ["Wei"]]]);
  assert.deepEqual(shape(groupPeople(contacts, "example.test")), [["Sales", ["Ann", "Wei"]]]);
  assert.deepEqual(shape(groupPeople(contacts, "转806")), [["Sales", ["Wei"]]]);
  assert.deepEqual(groupPeople(contacts, "999"), []);
});

test("each row offers the email and the phone to copy", () => {
  const page = read("../src/people.ts");
  assert.match(page, /person\.email \? contactButton\(person\.email, Mail, "Copy email"\)/);
  assert.match(page, /person\.phone \? contactButton\(person\.phone, Phone, "Copy phone number"\)/);
  assert.match(page, /copyText\(value, event\.currentTarget as HTMLButtonElement\)/);
});

test("the directory is a view of its own, reachable from the browse grid", () => {
  const shell = read("../src/shell.ts");
  assert.equal(shell.match(/case "people":\n\s+void renderPeoplePage\(\);/g)?.length, 2);
  assert.match(read("../src/shell-state.ts"), /"people",/);
  assert.match(read("../src/browse.ts"), /to\("people", Users, "Directory"/);
  assert.match(read("../src/document-title.ts"), /people: "Directory",/);
  assert.match(read("../src/people.ts"), /api<\{ people\?: DirectoryPerson\[\] \}>\("\/api\/directory\/people"\)/);
});
