import {
  cloneProject,
  type CourseModule,
  type CourseProject,
  type FrozenVersion,
  type LessonStep,
  type PendingOperation,
  type StepReference,
  type TeacherId,
  localStateKey,
  migrateLegacyProject,
  outboxKey,
  reconcileReferences,
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
} from './models';

/** 两个窗口共同读写的「共享课程文档」键；每位老师本地另有工作副本与发件箱 */
const SHARED_KEY = 'sologsb-1012-shared-course-v2';

export { SHARED_KEY };

export interface SharedDoc {
  project: CourseProject;
  updatedAt: string;
}

export function clientIdForTeacher(teacherId: TeacherId): string {
  return teacherId === 'teacher-guest' ? `guest-${guestSuffix()}` : teacherId;
}

function guestSuffix(): string {
  if (typeof sessionStorage === 'undefined') return Math.random().toString(36).slice(2, 8);
  let suffix = sessionStorage.getItem('sologsb-1012-guest-suffix');
  if (!suffix) {
    suffix = Math.random().toString(36).slice(2, 8);
    sessionStorage.setItem('sologsb-1012-guest-suffix', suffix);
  }
  return suffix;
}

function readJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/**
 * 载入共享文档：优先现有共享文档，其次旧 v2 键，再迁移 v1 老课程，
 * 都没有时由调用方传入演示课程。迁移完成后旧键保留不动作为备份。
 */
export function bootstrapShared(fallback: CourseProject): SharedDoc {
  const shared = readJson<SharedDoc>(SHARED_KEY);
  if (shared?.project?.schemaVersion === 2) return shared;

  const v2 = readJson<CourseProject>(STORAGE_KEY);
  if (v2?.schemaVersion === 2) {
    const doc = { project: v2, updatedAt: new Date().toISOString() };
    writeJson(SHARED_KEY, doc);
    return doc;
  }

  const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacyRaw) {
    const migrated = migrateLegacyProject(legacyRaw);
    if (migrated) {
      const doc = { project: migrated, updatedAt: new Date().toISOString() };
      writeJson(SHARED_KEY, doc);
      return doc;
    }
  }

  const doc = { project: fallback, updatedAt: new Date().toISOString() };
  writeJson(SHARED_KEY, doc);
  return doc;
}

export function loadShared(): SharedDoc | undefined {
  return readJson<SharedDoc>(SHARED_KEY);
}

export function saveShared(doc: SharedDoc): void {
  writeJson(SHARED_KEY, doc);
}

export function loadOutbox(clientId: string): PendingOperation[] {
  return readJson<PendingOperation[]>(outboxKey(clientId)) ?? [];
}

export function saveOutbox(clientId: string, outbox: PendingOperation[]): void {
  writeJson(outboxKey(clientId), outbox);
}

export function loadLocalState(clientId: string): CourseProject | undefined {
  return readJson<CourseProject>(localStateKey(clientId));
}

export function saveLocalState(clientId: string, project: CourseProject): void {
  writeJson(localStateKey(clientId), project);
}

export function clearLocalState(clientId: string): void {
  localStorage.removeItem(localStateKey(clientId));
}

export function ownedModules(project: CourseProject, teacherId: TeacherId): CourseModule[] {
  return project.modules.filter((module) => module.ownerId === teacherId);
}

/** 把一条操作纯函数式地应用到课程上；目标已一致的改动跳过（已对上的不动） */
export function applyOperation(project: CourseProject, op: PendingOperation): { project: CourseProject; skipped: boolean } {
  const payload = op.payload;
  const touched = new Date().toISOString();
  // 归属保护：老师只能改自己名下的模块，避免离线重放覆盖对方窗口的改动
  const ownsModule = (moduleId: string): boolean => {
    const module = project.modules.find((item) => item.id === moduleId);
    return Boolean(module && module.ownerId === op.teacherId);
  };

  switch (payload.type) {
    case 'patchCourse': {
      const fields = payload.fields;
      if (Object.entries(fields).every(([key, value]) => deepEqual((project as any)[key], value))) return { project, skipped: true };
      return { project: { ...project, ...fields, lastSavedAt: touched }, skipped: false };
    }
    case 'addModule': {
      if (project.modules.some((module) => module.id === payload.module.id)) return { project, skipped: true };
      return { project: { ...project, modules: [...project.modules, payload.module], lastSavedAt: touched }, skipped: false };
    }
    case 'removeModule': {
      if (!ownsModule(payload.moduleId)) return { project, skipped: true };
      if (!project.modules.some((module) => module.id === payload.moduleId)) return { project, skipped: true };
      const stepIds = new Set(project.modules.find((module) => module.id === payload.moduleId)?.steps.map((step) => step.id) ?? []);
      return {
        project: {
          ...project,
          modules: project.modules.filter((module) => module.id !== payload.moduleId),
          references: project.references.filter((reference) =>
            reference.ownerModuleId !== payload.moduleId && !stepIds.has(reference.targetStepId)),
        },
        skipped: false,
      };
    }
    case 'claimModule': {
      const module = project.modules.find((item) => item.id === payload.moduleId);
      if (!module) return { project, skipped: true };
      if (module.ownerId === payload.ownerId) return { project, skipped: true };
      if (module.ownerId !== '') return { project, skipped: true }; // 已被别的老师认领，先到先得
      return {
        project: {
          ...project,
          modules: project.modules.map((item) => item.id === payload.moduleId ? { ...item, ownerId: payload.ownerId } : item),
          lastSavedAt: touched,
        },
        skipped: false,
      };
    }
    case 'patchModule': {
      const module = project.modules.find((item) => item.id === payload.moduleId);
      if (!module || !ownsModule(payload.moduleId)) return { project, skipped: true };
      if (Object.entries(payload.fields).every(([key, value]) => deepEqual((module as any)[key], value))) return { project, skipped: true };
      return {
        project: {
          ...project,
          modules: project.modules.map((item) => item.id === payload.moduleId ? { ...item, ...payload.fields } : item),
          lastSavedAt: touched,
        },
        skipped: false,
      };
    }
    case 'replaceModule': {
      const index = project.modules.findIndex((item) => item.id === payload.module.id);
      if (index >= 0 && !ownsModule(payload.module.id)) return { project, skipped: true };
      if (index < 0) {
        return { project: { ...project, modules: [...project.modules, cloneModule(payload.module)], lastSavedAt: touched }, skipped: false };
      }
      if (deepEqual(project.modules[index], payload.module)) return { project, skipped: true };
      const modules = [...project.modules];
      modules[index] = cloneModule(payload.module);
      return { project: { ...project, modules, lastSavedAt: touched }, skipped: false };
    }
    case 'addStep': {
      const module = project.modules.find((item) => item.id === payload.moduleId);
      if (!module || !ownsModule(payload.moduleId)) return { project, skipped: true };
      if (module.steps.some((step) => step.id === payload.step.id)) return { project, skipped: true };
      return {
        project: {
          ...project,
          modules: project.modules.map((item) => item.id === payload.moduleId
            ? { ...item, steps: [...item.steps, payload.step] }
            : item),
          lastSavedAt: touched,
        },
        skipped: false,
      };
    }
    case 'patchStep': {
      const module = project.modules.find((item) => item.id === payload.moduleId);
      const step = module?.steps.find((item) => item.id === payload.stepId);
      if (!module || !step || !ownsModule(payload.moduleId)) return { project, skipped: true };
      if (Object.entries(payload.fields).every(([key, value]) => deepEqual((step as any)[key], value))) return { project, skipped: true };
      return {
        project: {
          ...project,
          modules: project.modules.map((item) => item.id !== payload.moduleId ? item : {
            ...item,
            steps: item.steps.map((s) => s.id === payload.stepId ? { ...s, ...payload.fields } as LessonStep : s),
          }),
          lastSavedAt: touched,
        },
        skipped: false,
      };
    }
    case 'deleteStep': {
      const module = project.modules.find((item) => item.id === payload.moduleId);
      if (!module || !ownsModule(payload.moduleId) || !module.steps.some((step) => step.id === payload.stepId)) return { project, skipped: true };
      return {
        project: {
          ...project,
          modules: project.modules.map((item) => item.id !== payload.moduleId ? item : {
            ...item,
            steps: item.steps.filter((step) => step.id !== payload.stepId),
          }),
          references: project.references.filter((reference) => reference.stepId !== payload.stepId),
          lastSavedAt: touched,
        },
        skipped: false,
      };
    }
    case 'moveStep': {
      const moduleIndex = project.modules.findIndex((item) => item.id === payload.moduleId);
      const module = project.modules[moduleIndex];
      if (!module || !ownsModule(payload.moduleId)) return { project, skipped: true };
      const index = module.steps.findIndex((step) => step.id === payload.stepId);
      const nextIndex = Math.max(0, Math.min(module.steps.length - 1, index + payload.direction));
      if (index < 0 || index === nextIndex) return { project, skipped: true };
      const steps = [...module.steps];
      const [item] = steps.splice(index, 1);
      steps.splice(nextIndex, 0, item);
      const modules = [...project.modules];
      modules[moduleIndex] = { ...module, steps };
      return { project: { ...project, modules, lastSavedAt: touched }, skipped: false };
    }
    case 'addReference': {
      if (project.references.some((reference) => reference.id === payload.reference.id)) return { project, skipped: true };
      if (!ownsModule(payload.reference.ownerModuleId)) return { project, skipped: true };
      return { project: { ...project, references: [...project.references, payload.reference], lastSavedAt: touched }, skipped: false };
    }
    case 'resolveReference': {
      const reference = project.references.find((item) => item.id === payload.referenceId);
      if (!reference) return { project, skipped: true };
      if (!ownsModule(reference.ownerModuleId)) return { project, skipped: true };
      if (payload.action === 'remove') {
        return { project: { ...project, references: project.references.filter((item) => item.id !== payload.referenceId), lastSavedAt: touched }, skipped: false };
      }
      if (reference.status === 'active') return { project, skipped: true };
      return {
        project: {
          ...project,
          references: project.references.map((item) => item.id === payload.referenceId
            ? { ...item, status: 'active', suspendReason: '', updatedAt: touched }
            : item),
          lastSavedAt: touched,
        },
        skipped: false,
      };
    }
    case 'addFrozen': {
      if (project.frozenVersions.some((version) => version.id === payload.version.id)) return { project, skipped: true };
      return { project: { ...project, frozenVersions: [payload.version, ...project.frozenVersions], lastSavedAt: touched }, skipped: false };
    }
  }
}

/** 删除/挪动之后需要重新核对的引用提示 */
export function hintsFor(op: PendingOperation): { deletedStepIds?: string[]; movedStepIds?: string[] } {
  if (op.payload.type === 'deleteStep') return { deletedStepIds: [op.payload.stepId] };
  if (op.payload.type === 'moveStep') return { movedStepIds: [op.payload.stepId] };
  return {};
}

function mergeReferences(base: StepReference[], incoming: StepReference[]): StepReference[] {
  const map = new Map<string, StepReference>();
  for (const reference of [...base, ...incoming]) {
    const existing = map.get(reference.id);
    if (!existing || new Date(reference.updatedAt).getTime() >= new Date(existing.updatedAt).getTime()) {
      map.set(reference.id, reference);
    }
  }
  return [...map.values()];
}

function mergeFrozen(base: FrozenVersion[], incoming: FrozenVersion[]): FrozenVersion[] {
  const map = new Map<string, FrozenVersion>();
  [...base, ...incoming].forEach((version) => map.set(version.id, version));
  return [...map.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * 保存窗口切片：只把本老师归属的模块覆盖进共享文档，其它老师的模块原样保留，
 * 引用表与冻结版本按 id 合并。两边同时保存时互不覆盖对方模块。
 */
export function saveSlice(shared: SharedDoc, working: CourseProject, teacherId: TeacherId): SharedDoc {
  const base = shared.project;
  const ownedIds = new Set(ownedModules(working, teacherId).map((module) => module.id));
  const localOwned = working.modules.filter((module) => ownedIds.has(module.id));

  const modules = base.modules.map((module) => {
    const replacement = localOwned.find((item) => item.id === module.id);
    return replacement ? cloneModule(replacement) : module;
  });
  localOwned.forEach((module) => {
    if (!modules.some((item) => item.id === module.id)) modules.push(cloneModule(module));
  });

  // 未认领模块在本窗口已被认领（claim 操作在线时通常已直接进共享，这里兜底）
  working.modules.forEach((module) => {
    if (module.ownerId !== teacherId) return;
    const target = modules.find((item) => item.id === module.id);
    if (target && target.ownerId === '') target.ownerId = teacherId;
  });

  const project: CourseProject = {
    ...base,
    title: working.title,
    teacher: working.teacher,
    audience: working.audience,
    status: working.status,
    modules,
    references: mergeReferences(base.references, working.references),
    frozenVersions: mergeFrozen(base.frozenVersions, working.frozenVersions),
    selectedModuleId: working.selectedModuleId,
    selectedStepId: working.selectedStepId,
    lastSavedAt: new Date().toISOString(),
    revision: base.revision + 1,
  };

  const doc = { project, updatedAt: new Date().toISOString() };
  saveShared(doc);
  return doc;
}

function cloneModule(module: CourseModule): CourseModule {
  return structuredClone(module);
}

/**
 * 用共享文档刷新工作副本：保留本窗口归属模块（含尚未推送的离线编辑），
 * 其余模块、引用与课程级字段以共享文档为准。
 */
export function pullShared(shared: SharedDoc, current: CourseProject, teacherId: TeacherId): CourseProject {
  const base = shared.project;
  const mine = new Set(ownedModules(current, teacherId).map((module) => module.id));
  const modules = base.modules.map((module) => {
    const local = current.modules.find((item) => item.id === module.id);
    return local && mine.has(module.id) ? local : module;
  });
  current.modules.forEach((module) => {
    if (mine.has(module.id) && !modules.some((item) => item.id === module.id)) modules.push(module);
  });

  const selectedModule = modules.find((module) => module.id === current.selectedModuleId) ?? modules[0];
  const selectedStepId = selectedModule?.steps.some((step) => step.id === current.selectedStepId)
    ? current.selectedStepId
    : selectedModule?.steps[0]?.id ?? '';
  return {
    ...base,
    modules,
    // 本窗口对自己引用的确认/编辑优先；其余以共享为准
    references: mergeReferences(base.references, current.references),
    selectedModuleId: selectedModule?.id ?? '',
    selectedStepId,
  };
}

export interface ReplayResult {
  doc: SharedDoc;
  applied: number;
  skipped: number;
  suspendedRefs: StepReference[];
}

/**
 * 网络恢复后把断网期间的发件箱按顺序补回共享课程：
 * 幂等操作跳过已一致的内容，最后统一核对跨模块引用并挂起失效项。
 */
export function replayOutbox(shared: SharedDoc, outbox: PendingOperation[]): ReplayResult {
  let project = cloneProject(shared.project);
  let applied = 0;
  let skipped = 0;
  const deletedStepIds: string[] = [];
  const movedStepIds: string[] = [];

  for (const op of outbox) {
    const result = applyOperation(project, op);
    if (result.skipped) {
      skipped += 1;
    } else {
      applied += 1;
      project = result.project;
    }
    const hints = hintsFor(op);
    deletedStepIds.push(...hints.deletedStepIds ?? []);
    movedStepIds.push(...hints.movedStepIds ?? []);
  }

  const reconciled = reconcileReferences(project, { deletedStepIds, movedStepIds });
  project = reconciled.project;
  const doc: SharedDoc = { project: { ...project, revision: shared.project.revision + (applied ? 1 : 0) }, updatedAt: new Date().toISOString() };
  saveShared(doc);
  return { doc, applied, skipped, suspendedRefs: reconciled.changed };
}

/** 发件箱操作的中文摘要，用于同步中心展示 */
export function describeOperation(op: PendingOperation): string {
  const p = op.payload;
  switch (p.type) {
    case 'patchCourse': return '修改课程信息';
    case 'addModule': return `新建模块「${p.module.title}」`;
    case 'removeModule': return '删除课程模块';
    case 'claimModule': return '认领模块归属';
    case 'patchModule': return `修改模块「${p.fields.title ?? p.moduleId}」`;
    case 'replaceModule': return `整体更新模块「${p.module.title}」`;
    case 'addStep': return `新增步骤「${p.step.title}」`;
    case 'patchStep': return `编辑步骤「${p.fields.title ?? p.stepId}」`;
    case 'deleteStep': return '删除学习步骤';
    case 'moveStep': return '调整步骤顺序';
    case 'addReference': return '建立跨模块前置引用';
    case 'resolveReference': return p.action === 'remove' ? '解除跨模块引用' : '确认保留跨模块引用';
    case 'addFrozen': return `冻结版本「${p.version.label}」`;
  }
}
