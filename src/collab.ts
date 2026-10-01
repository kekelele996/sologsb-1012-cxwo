import { cloneProject, createDemoProject, type CourseModule, type CourseProject, type FrozenVersion, type LessonStep, type StepRef, type TeacherId } from './models';

export interface TeacherInfo {
  id: TeacherId;
  name: string;
  short: string;
  moduleName: string;
  color: string;
}

export const TEACHERS: Record<TeacherId, TeacherInfo> = {
  'teacher-1': { id: 'teacher-1', name: '陈老师', short: '陈', moduleName: '模块一', color: '#15827a' },
  'teacher-2': { id: 'teacher-2', name: '林老师', short: '林', moduleName: '模块二', color: '#8a3ffc' },
};

export const SHARED_KEY = 'sologsb-1012-shared-v1';
export const WINDOW_KEY_PREFIX = 'sologsb-1012-window-v1-';
const CHANNEL_NAME = 'sologsb-1012-collab-v1';

/** 需要在窗口之间按“最后写入优先”合并的课程级标量字段。 */
export const SCALAR_FIELDS = ['title', 'teacher', 'audience', 'status', 'revision', 'lastSavedAt'] as const;
export type ScalarField = (typeof SCALAR_FIELDS)[number];

export interface SharedDoc {
  project: CourseProject;
  updatedAt: string;
  scalarUpdatedAt: Partial<Record<ScalarField, string>>;
}

export interface WindowState {
  project: CourseProject;
  pendingModules: string[];
  pendingScalars: ScalarField[];
  scalarUpdatedAt: Partial<Record<ScalarField, string>>;
}

export interface MergeResult {
  project: CourseProject;
  scalarUpdatedAt: Partial<Record<ScalarField, string>>;
  /** 断网期间本窗口改过、但与课程现状完全一致的模块（未重复写入）。 */
  noopModuleIds: string[];
  changedModuleIds: string[];
}

export function teacherFromLocation(): TeacherId {
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get('teacher');
    if (value === '2' || value === 'teacher-2') return 'teacher-2';
  } catch {
    /* 非浏览器环境或参数不可读时使用默认身份 */
  }
  return 'teacher-1';
}

export function windowKey(teacherId: TeacherId): string {
  return `${WINDOW_KEY_PREFIX}${teacherId}`;
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 把旧版本（v1）本地数据迁移到“模块归属 + 跨模块引用”模型。 */
export function migrateProject(input: unknown): CourseProject {
  if (!input || typeof input !== 'object' || !Array.isArray((input as CourseProject).modules)) {
    return input as CourseProject;
  }
  const project = input as CourseProject;
  project.modules.forEach((module, index) => {
    if (!module.ownerId) module.ownerId = index % 2 === 0 ? 'teacher-1' : 'teacher-2';
    module.steps?.forEach((step) => {
      const legacy = (step as LessonStep & { prerequisiteId?: string }).prerequisiteId;
      if (!step.prerequisite) {
        step.prerequisite = legacy
          ? { moduleId: module.id, stepId: legacy, status: 'active' }
          : null;
      } else {
        step.prerequisite.status = step.prerequisite.status ?? 'active';
      }
      delete (step as LessonStep & { prerequisiteId?: string }).prerequisiteId;
    });
  });
  return project;
}

export function loadWindowState(teacherId: TeacherId): WindowState | null {
  const state = safeParse<WindowState>(localStorage.getItem(windowKey(teacherId)));
  if (!state) return null;
  state.project = migrateProject(state.project);
  state.pendingModules = state.pendingModules ?? [];
  state.pendingScalars = state.pendingScalars ?? [];
  state.scalarUpdatedAt = state.scalarUpdatedAt ?? {};
  return state;
}

export function saveWindowState(teacherId: TeacherId, state: WindowState): void {
  localStorage.setItem(windowKey(teacherId), JSON.stringify(state));
}

export function loadSharedDoc(): SharedDoc | null {
  const doc = safeParse<SharedDoc>(localStorage.getItem(SHARED_KEY));
  if (!doc) return null;
  doc.project = migrateProject(doc.project);
  doc.scalarUpdatedAt = doc.scalarUpdatedAt ?? {};
  return doc;
}

export function saveSharedDoc(doc: SharedDoc): void {
  localStorage.setItem(SHARED_KEY, JSON.stringify(doc));
}

/** 引用对账：目标被删除则挂起；被移动到其他模块则挂起并记录新位置。 */
export function reconcileReferences(project: CourseProject): void {
  for (const module of project.modules) {
    for (const step of module.steps) {
      const ref: StepRef | null = step.prerequisite;
      if (!ref) continue;
      let located: CourseModule | undefined;
      for (const candidate of project.modules) {
        if (candidate.steps.some((candidateStep) => candidateStep.id === ref.stepId)) {
          located = candidate;
          break;
        }
      }
      if (!located) {
        ref.status = 'suspended';
        ref.reason = 'deleted';
        delete ref.movedToModuleId;
      } else if (located.id !== ref.moduleId) {
        ref.status = 'suspended';
        ref.reason = 'moved';
        ref.movedToModuleId = located.id;
      } else {
        ref.status = 'active';
        delete ref.reason;
        delete ref.movedToModuleId;
      }
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 以共享课程为底，把本窗口的改动合并进去：
 * - 模块按归属合并：谁负责的模块就以谁的版本为准，两边同时保存不会互相覆盖；
 * - 课程级标量字段按时间戳最后写入优先；
 * - 冻结版本按 id 并集；
 * - 选择状态只属于本窗口，不参与同步。
 */
export function mergeForWindow(
  local: CourseProject,
  shared: SharedDoc | null,
  teacherId: TeacherId,
  pendingModules: string[],
  localScalarUpdatedAt: Partial<Record<ScalarField, string>>,
): MergeResult {
  const result: CourseProject = shared ? cloneProject(shared.project) : cloneProject(local);
  const pendingSet = new Set(pendingModules);

  const localModuleMap = new Map(local.modules.map((module) => [module.id, module]));
  const nextModules: CourseModule[] = [];
  const noopModuleIds: string[] = [];
  const changedModuleIds: string[] = [];

  for (const sharedModule of result.modules) {
    const localModule = localModuleMap.get(sharedModule.id);
    if (sharedModule.ownerId === teacherId) {
      if (!localModule) continue; // 本窗口删除了自己负责的模块
      if (pendingSet.has(sharedModule.id) && deepEqual(localModule, sharedModule)) {
        noopModuleIds.push(sharedModule.id);
        nextModules.push(structuredClone(sharedModule));
      } else if (!deepEqual(localModule, sharedModule)) {
        changedModuleIds.push(sharedModule.id);
        nextModules.push(structuredClone(localModule));
      } else {
        nextModules.push(structuredClone(sharedModule));
      }
    } else {
      nextModules.push(structuredClone(sharedModule));
    }
  }
  for (const localModule of local.modules) {
    if (localModule.ownerId === teacherId && !result.modules.some((module) => module.id === localModule.id)) {
      nextModules.push(structuredClone(localModule));
      changedModuleIds.push(localModule.id);
    }
  }
  result.modules = nextModules;

  const nextScalarUpdatedAt: Partial<Record<ScalarField, string>> = { ...(shared?.scalarUpdatedAt ?? {}) };
  for (const field of SCALAR_FIELDS) {
    const localTs = localScalarUpdatedAt[field];
    const sharedTs = nextScalarUpdatedAt[field];
    if (localTs && (!sharedTs || localTs > sharedTs)) {
      (result as unknown as Record<string, unknown>)[field] = (local as unknown as Record<string, unknown>)[field];
      nextScalarUpdatedAt[field] = localTs;
    }
  }

  const frozenMap = new Map<string, FrozenVersion>();
  for (const version of [...(shared?.project.frozenVersions ?? []), ...local.frozenVersions]) {
    const existing = frozenMap.get(version.id);
    if (!existing || version.createdAt > existing.createdAt) frozenMap.set(version.id, version);
  }
  result.frozenVersions = [...frozenMap.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  result.selectedModuleId = local.selectedModuleId;
  result.selectedStepId = local.selectedStepId;

  reconcileReferences(result);
  return { project: result, scalarUpdatedAt: nextScalarUpdatedAt, noopModuleIds, changedModuleIds };
}

export function emptySharedDoc(project: CourseProject): SharedDoc {
  return { project: cloneProject(project), updatedAt: new Date().toISOString(), scalarUpdatedAt: {} };
}

/** 广播共享文档更新；BroadcastChannel 不可用时由 storage 事件兜底。 */
export function broadcast(doc: SharedDoc): void {
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ type: 'shared-updated', updatedAt: doc.updatedAt });
    channel.close();
  } catch {
    /* 部分浏览器不支持 BroadcastChannel，依赖 storage 事件 */
  }
}

export function subscribeShared(callback: (doc: SharedDoc) => void): () => void {
  let channel: BroadcastChannel | undefined;
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === 'shared-updated') {
      const doc = loadSharedDoc();
      if (doc) callback(doc);
    }
  };
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.addEventListener('message', onMessage);
    }
  } catch {
    channel = undefined;
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === SHARED_KEY && event.newValue) {
      const doc = loadSharedDoc();
      if (doc) callback(doc);
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    channel?.removeEventListener('message', onMessage);
    channel?.close();
    window.removeEventListener('storage', onStorage);
  };
}

export { createDemoProject };
