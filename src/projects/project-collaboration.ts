import { randomUUID } from "node:crypto";
import { orgId } from "../config.ts";
import { samePerson } from "../directory/person.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { Project, ProjectStore } from "./project-store.ts";

interface ProjectMaterialLink {
  title: string;
  url: string;
}

interface ProjectAnnouncementRevision {
  version: number;
  title: string;
  body: string;
  pinned: boolean;
  expiresAt: number | null;
  archived: boolean;
  updatedAt: number;
  updatedBy: string;
}

interface ProjectAnnouncement extends ProjectAnnouncementRevision {
  id: string;
  createdAt: number;
  createdBy: string;
  history: ProjectAnnouncementRevision[];
}

interface ProjectTodo {
  id: string;
  version: number;
  title: string;
  assigneeId: string;
  dueAt: number | null;
  status: "open" | "doing" | "done" | "cancelled";
  pinned: boolean;
  sourceUrl: string;
  resultUrl: string;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
}

export interface ProjectBoard {
  projectId: string;
  metadataVersion: number;
  tags: string[];
  important: boolean;
  urgent: boolean;
  materials: ProjectMaterialLink[];
  announcements: ProjectAnnouncement[];
  todos: ProjectTodo[];
}

export interface ProjectBoardView extends ProjectBoard {
  pinned: boolean;
  canManage: boolean;
}

export type ProjectBoardCommand =
  | { kind: "pin"; pinned: boolean }
  | {
      kind: "metadata";
      baseVersion: number;
      tags: string[];
      important: boolean;
      urgent: boolean;
      materials: ProjectMaterialLink[];
    }
  | {
      kind: "announcement";
      id?: string;
      baseVersion?: number;
      title: string;
      body: string;
      pinned: boolean;
      expiresAt: number | null;
      archived: boolean;
    }
  | {
      kind: "todo";
      id?: string;
      baseVersion?: number;
      title: string;
      assigneeId: string;
      dueAt: number | null;
      status: ProjectTodo["status"];
      pinned: boolean;
      sourceUrl: string;
      resultUrl: string;
    };

export class ProjectBoardError extends Error {
  status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

function fail(status: 400 | 403 | 404 | 409, message: string): never {
  throw new ProjectBoardError(status, message);
}

function cleanText(value: unknown, max: number, required = true): string {
  if (typeof value !== "string") return fail(400, "Enter valid text.");
  const text = value.trim();
  if ((required && !text) || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text))
    return fail(400, `Text cannot be empty or exceed ${max} characters.`);
  return text;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") return fail(400, "Choose a valid option.");
  return value;
}

function date(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000)
    return fail(400, "Invalid date.");
  return value;
}

function link(value: unknown, material = false): string {
  const text = cleanText(value, 2048, material);
  if (!text) return "";
  if (text.includes("\\") || /\s/u.test(text)) return fail(400, "Invalid link.");
  try {
    const url = new URL(text, "https://coworker.invalid");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || text.startsWith("//"))
      return fail(400, "Links must be web addresses or paths on this site.");
    if (material && (!text.startsWith("/pm/p/") || url.origin !== "https://coworker.invalid"))
      return fail(400, "Use a /pm/p/ project page address from project management for material links.");
    return text;
  } catch (error) {
    if (error instanceof ProjectBoardError) throw error;
    return fail(400, "Invalid link.");
  }
}

function emptyBoard(projectId: string): ProjectBoard {
  return {
    projectId,
    metadataVersion: 0,
    tags: [],
    important: false,
    urgent: false,
    materials: [],
    announcements: [],
    todos: [],
  };
}

export function createProjectCollaborationStore(
  projects: ProjectStore,
  boards: DurableMap<ProjectBoard>,
  preferences: DurableMap<string[]>,
  options: { isActiveMember: (id: string) => boolean; now?: () => number; id?: () => string },
) {
  const now = options.now ?? Date.now;
  const nextId = options.id ?? randomUUID;
  const key = (id: string) => JSON.stringify([orgId(), id]);
  const allowed = (project: Project, actor: string) =>
    project.orgId === orgId() &&
    options.isActiveMember(actor) &&
    options.isActiveMember(project.ownerId) &&
    [...project.memberIds, ...(project.channelMemberIds ?? [])].some((member) => samePerson(member, actor));

  async function authorized<T>(id: string, actor: string, operation: (project: Project) => Promise<T>): Promise<T> {
    const result = await projects.withRosterLock(id, async (project) => {
      if (!allowed(project, actor)) return fail(404, "Project not found or you no longer have access.");
      return operation(project);
    });
    if (result === null) return fail(404, "Project not found or you no longer have access.");
    return result;
  }

  async function view(project: Project, actor: string): Promise<ProjectBoardView> {
    const board = (await boards.get(key(project.id))) ?? emptyBoard(project.id);
    return structuredClone({
      ...board,
      pinned: ((await preferences.get(key(actor))) ?? []).includes(project.id),
      canManage: samePerson(project.ownerId, actor),
    });
  }

  async function read(id: string, actor: string): Promise<ProjectBoardView> {
    return authorized(id, actor, (project) => view(project, actor));
  }

  return {
    read,
    async pinnedIds(actor: string): Promise<string[]> {
      return (await preferences.get(key(actor))) ?? [];
    },
    async summaries(actor: string) {
      const result = [];
      for (const project of await projects.listForMember(actor)) {
        try {
          const board = await read(project.id, actor);
          result.push({
            projectId: project.id,
            pinned: board.pinned,
            tags: board.tags,
            important: board.important,
            urgent: board.urgent,
          });
        } catch (error) {
          if (!(error instanceof ProjectBoardError) || error.status !== 404) throw error;
        }
      }
      return result;
    },
    async update(id: string, actor: string, command: ProjectBoardCommand): Promise<ProjectBoardView> {
      return authorized(id, actor, async (project) => {
        if (!command || typeof command !== "object") return fail(400, "Invalid action.");
        if (command.kind === "pin") {
          const pinned = boolean(command.pinned);
          if (!preferences.update) throw new Error("project preferences require atomic update");
          await preferences.putIfAbsent(key(actor), []);
          await preferences.update(key(actor), (ids) =>
            pinned ? [...new Set([...ids, id])] : ids.filter((value) => value !== id),
          );
          return view(project, actor);
        }
        if (!boards.update) throw new Error("project board requires atomic update");
        await boards.putIfAbsent(key(id), emptyBoard(id));
        await boards.update(key(id), (stored) => {
          const board = structuredClone(stored);
          const manager = samePerson(project.ownerId, actor);
          if (command.kind === "metadata") {
            if (!manager) return fail(403, "Only the project owner can manage categories and material links.");
            if (command.baseVersion !== board.metadataVersion) return fail(409, "Settings changed; refresh and save.");
            if (
              !Array.isArray(command.tags) ||
              command.tags.length > 10 ||
              !Array.isArray(command.materials) ||
              command.materials.length > 20
            )
              return fail(400, "At most 10 category tags and 20 material links.");
            board.tags = [...new Set(command.tags.map((tag) => cleanText(tag, 30)))];
            board.important = boolean(command.important);
            board.urgent = boolean(command.urgent);
            board.materials = command.materials.map((item) => ({
              title: cleanText(item?.title, 100),
              url: link(item?.url, true),
            }));
            board.metadataVersion++;
          } else if (command.kind === "announcement") {
            if (!manager) return fail(403, "Only the project owner can publish and manage announcements.");
            const existing = command.id ? board.announcements.find((item) => item.id === command.id) : undefined;
            if (command.id && !existing) return fail(404, "Announcement not found.");
            if (existing && command.baseVersion !== existing.version) return fail(409, "Announcement changed; reload.");
            if (!existing && board.announcements.length >= 100)
              return fail(409, "This project has reached its announcement limit; history is kept.");
            const revision: ProjectAnnouncementRevision = {
              version: (existing?.version ?? 0) + 1,
              title: cleanText(command.title, 200),
              body: cleanText(command.body, 8000),
              pinned: boolean(command.pinned),
              expiresAt: date(command.expiresAt),
              archived: boolean(command.archived),
              updatedAt: now(),
              updatedBy: actor,
            };
            if (existing) {
              const {
                id: _id,
                createdAt: _createdAt,
                createdBy: _createdBy,
                history: _history,
                ...previous
              } = existing;
              existing.history.push(previous);
              Object.assign(existing, revision);
            } else {
              board.announcements.push({
                ...revision,
                id: nextId(),
                createdAt: revision.updatedAt,
                createdBy: actor,
                history: [],
              });
            }
          } else if (command.kind === "todo") {
            const existing = command.id ? board.todos.find((item) => item.id === command.id) : undefined;
            if (command.id && !existing) return fail(404, "To-do not found.");
            if (existing && command.baseVersion !== existing.version) return fail(409, "To-do changed; reload.");
            if (!existing && board.todos.length >= 500) return fail(409, "To-do limit reached; records are kept.");
            const assigneeId = cleanText(command.assigneeId, 320);
            if (
              (!existing || existing.assigneeId !== assigneeId) &&
              (!options.isActiveMember(assigneeId) ||
                ![...project.memberIds, ...(project.channelMemberIds ?? [])].includes(assigneeId))
            )
              return fail(400, "The assignee must be a current project member.");
            if (!["open", "doing", "done", "cancelled"].includes(command.status)) return fail(400, "Bad to-do status.");
            const fields = {
              title: cleanText(command.title, 300),
              assigneeId,
              dueAt: date(command.dueAt),
              status: command.status,
              pinned: boolean(command.pinned),
              sourceUrl: link(command.sourceUrl),
              resultUrl: link(command.resultUrl),
            };
            if (existing && !manager && existing.createdBy !== actor) {
              if (existing.assigneeId !== actor) return fail(403, "Creator, assignee or owner only.");
              if (
                fields.title !== existing.title ||
                fields.assigneeId !== existing.assigneeId ||
                fields.dueAt !== existing.dueAt ||
                fields.pinned !== existing.pinned ||
                fields.sourceUrl !== existing.sourceUrl
              )
                return fail(403, "Assignee can update status and links; other fields belong to the creator or owner.");
            }
            if (existing)
              Object.assign(existing, fields, { version: existing.version + 1, updatedAt: now(), updatedBy: actor });
            else
              board.todos.push({
                ...fields,
                id: nextId(),
                version: 1,
                createdAt: now(),
                createdBy: actor,
                updatedAt: now(),
                updatedBy: actor,
              });
          } else return fail(400, "Invalid action.");
          if (JSON.stringify(board).length > 2_000_000)
            return fail(409, "Project collaboration records are full; this change was not saved. History is kept.");
          return board;
        });
        return view(project, actor);
      });
    },
  };
}

export type ProjectCollaborationStore = ReturnType<typeof createProjectCollaborationStore>;
