export type CourseStatus = 'draft' | 'review' | 'changes' | 'frozen';
export type Difficulty = '入门' | '进阶' | '挑战';
export type CameraAngle = '正面' | '左侧 45°' | '右侧 45°' | '俯拍手部' | '全身远景';
export type CaptionPosition = '下方安全区' | '上移 15%' | '角标提示' | '画面中央';
export type GestureZone = '左侧' | '中央' | '右侧';

export type TeacherId = 'teacher-lin' | 'teacher-zhao' | 'teacher-guest';

/** 引用状态：active 正常；suspended 被引用步骤被删除或挪动，等待引用方确认 */
export type ReferenceStatus = 'active' | 'suspended';

export interface Teacher {
  id: TeacherId;
  name: string;
  initial: string;
  color: string;
  scope: string;
}

export const TEACHERS: Teacher[] = [
  { id: 'teacher-lin', name: '林老师', initial: '林', color: '#15827a', scope: '负责模块一' },
  { id: 'teacher-zhao', name: '赵老师', initial: '赵', color: '#8a3ffc', scope: '负责模块二' },
  { id: 'teacher-guest', name: '访客（只读）', initial: '客', color: '#66758a', scope: '无归属模块' },
];

export function teacherById(id: TeacherId): Teacher {
  return TEACHERS.find((teacher) => teacher.id === id) ?? TEACHERS[2];
}

/** 跨模块前置引用。模块内部前置仍直接存在 step.prerequisiteId 上 */
export interface StepReference {
  id: string;
  /** 引用方（模块二的学习步骤） */
  stepId: string;
  ownerModuleId: string;
  /** 被引用方（模块一的学习步骤） */
  targetStepId: string;
  targetModuleId: string;
  status: ReferenceStatus;
  /** 挂起原因，供引用方老师确认时阅读 */
  suspendReason: string;
  createdAt: string;
  updatedAt: string;
}

export interface LessonStep {
  id: string;
  title: string;
  kind: '示范' | '讲解' | '练习';
  duration: number;
  demoTitle: string;
  demoUrl: string;
  handshape: string;
  gestureZone: GestureZone;
  caption: string;
  captionPosition: CaptionPosition;
  camera: CameraAngle;
  commonMistakes: string[];
  exercise: string;
  exerciseFeedback: string;
  altText: string;
  /** 模块内部前置步骤 id；跨模块前置见 CourseProject.references */
  prerequisiteId: string;
  difficulty: Difficulty;
  cuePoints: number[];
}

export interface CourseModule {
  id: string;
  title: string;
  summary: string;
  color: string;
  /** 归属老师 id；空串表示尚未认领（先到先得） */
  ownerId: TeacherId | '';
  steps: LessonStep[];
}

export interface FrozenVersion {
  id: string;
  label: string;
  createdAt: string;
  snapshot: Omit<CourseProject, 'frozenVersions'>;
}

/** 离线期间产生、尚未补回共享文档的改动记录 */
export interface PendingOperation {
  id: string;
  clientId: string;
  teacherId: TeacherId;
  at: string;
  label: string;
  payload: OperationPayload;
}

export type OperationPayload =
  | { type: 'patchCourse'; fields: Partial<Pick<CourseProject, 'title' | 'teacher' | 'audience' | 'status'>> }
  | { type: 'addModule'; module: CourseModule }
  | { type: 'removeModule'; moduleId: string }
  | { type: 'claimModule'; moduleId: string; ownerId: TeacherId }
  | { type: 'patchModule'; moduleId: string; fields: Partial<Pick<CourseModule, 'title' | 'summary' | 'color'>> }
  | { type: 'replaceModule'; module: CourseModule }
  | { type: 'addStep'; moduleId: string; step: LessonStep }
  | { type: 'patchStep'; moduleId: string; stepId: string; fields: Partial<Omit<LessonStep, 'id'>> }
  | { type: 'deleteStep'; moduleId: string; stepId: string }
  | { type: 'moveStep'; moduleId: string; stepId: string; direction: -1 | 1 }
  | { type: 'addReference'; reference: StepReference }
  | { type: 'resolveReference'; referenceId: string; action: 'reaffirm' | 'remove' }
  | { type: 'addFrozen'; version: FrozenVersion };

export interface CourseProject {
  id: string;
  title: string;
  teacher: string;
  audience: string;
  status: CourseStatus;
  selectedModuleId: string;
  selectedStepId: string;
  modules: CourseModule[];
  references: StepReference[];
  frozenVersions: FrozenVersion[];
  lastSavedAt: string;
  revision: number;
  /** 数据模型版本：2 = 归属 + 引用 + 离线回放 */
  schemaVersion: 2;
}

export interface ValidationCheck {
  id: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  stepId?: string;
  moduleId?: string;
}

export const STORAGE_KEY = 'sologsb-1012-sign-course-project-v2';
/** 旧版本（无归属/引用模型）使用的键，用于迁移 */
export const LEGACY_STORAGE_KEY = 'sologsb-1012-sign-course-project-v1';
export const IDENTITY_KEY = 'sologsb-1012-active-teacher';
export const localStateKey = (clientId: string) => `sologsb-1012-local-${clientId}`;
export const outboxKey = (clientId: string) => `sologsb-1012-outbox-${clientId}`;

export function createDemoProject(): CourseProject {
  const modules: CourseModule[] = [
    {
      id: 'module-1',
      title: '模块一 · 日常问候',
      summary: '建立手形、视线和面部表情之间的配合，完成三个基础问候。',
      color: '#15827a',
      ownerId: 'teacher-lin',
      steps: [
        {
          id: 'step-1-1',
          title: '观察“你好”的完整动作',
          kind: '示范',
          duration: 35,
          demoTitle: '你好 · 正面慢速示范',
          demoUrl: '',
          handshape: '右手掌张开，拇指向上，自额头向外送出',
          gestureZone: '右侧',
          caption: '你好：手掌从额前向前送出，同时保持微笑。',
          captionPosition: '下方安全区',
          camera: '正面',
          commonMistakes: ['手掌过于僵硬', '没有视线交流'],
          exercise: '跟随示范完成两次，每次保持两秒。',
          exerciseFeedback: '镜面检查手掌高度是否与眉线一致。',
          altText: '教师面向镜头，用右手掌从额头向前送出，并点头微笑。',
          prerequisiteId: '',
          difficulty: '入门',
          cuePoints: [4, 16, 28],
        },
        {
          id: 'step-1-2',
          title: '拆解“你好”的手形',
          kind: '讲解',
          duration: 50,
          demoTitle: '你好 · 手部近景',
          demoUrl: '',
          handshape: '四指并拢，拇指张开；掌心朝左前侧',
          gestureZone: '中央',
          caption: '注意四指并拢，动作沿身体中轴向前。',
          captionPosition: '画面中央',
          camera: '俯拍手部',
          commonMistakes: ['拇指贴住掌心', '动作方向偏向一侧'],
          exercise: '固定肩部，只移动前臂完成五次。',
          exerciseFeedback: '如果动作跑偏，先在镜前标记起点和终点。',
          altText: '手部近景展示四指并拢、拇指张开的起始手形。',
          prerequisiteId: 'step-1-1',
          difficulty: '入门',
          cuePoints: [6, 24, 42],
        },
        {
          id: 'step-1-3',
          title: '双人问候练习',
          kind: '练习',
          duration: 75,
          demoTitle: '你好 · 双人轮流练习',
          demoUrl: '',
          handshape: '保持标准手形，配合点头与视线交换',
          gestureZone: '中央',
          caption: '轮流问候，每次动作结束后停一拍，再交换角色。',
          captionPosition: '上移 15%',
          camera: '全身远景',
          commonMistakes: ['动作过早结束', '两人视线没有相遇'],
          exercise: '两人一组轮流完成问候，交换三次。',
          exerciseFeedback: '同伴负责确认视线和动作停顿。',
          altText: '两名学习者相对站立，交替做出问候动作并看向对方。',
          prerequisiteId: 'step-1-2',
          difficulty: '进阶',
          cuePoints: [10, 34, 57],
        },
      ],
    },
    {
      id: 'module-2',
      title: '模块二 · 数量表达',
      summary: '用数字、空间位置和顺序词完成价格询问。',
      color: '#8a3ffc',
      ownerId: 'teacher-zhao',
      steps: [
        {
          id: 'step-2-1',
          title: '数字一到五的稳定手形',
          kind: '讲解',
          duration: 60,
          demoTitle: '数字 1—5 · 镜面视图',
          demoUrl: '',
          handshape: '食指到五指依次展开，手心朝前',
          gestureZone: '中央',
          caption: '数字一到五：从食指开始依次增加，不移动手腕。',
          captionPosition: '下方安全区',
          camera: '正面',
          commonMistakes: ['拇指遮挡手指数', '手腕左右摆动'],
          exercise: '按随机口令连续展示 1—5。',
          exerciseFeedback: '每个数字保持一秒，同伴随机报数。',
          altText: '教师手心朝前，依次伸出食指到五指，展示数字一到五。',
          prerequisiteId: '',
          difficulty: '入门',
          cuePoints: [8, 26, 44],
        },
        {
          id: 'step-2-2',
          title: '组合成“多少钱”',
          kind: '示范',
          duration: 45,
          demoTitle: '多少钱 · 双手组合动作',
          demoUrl: '',
          handshape: '双手在胸前交替翻转，随后食指向前点出',
          gestureZone: '中央',
          caption: '先做“钱”的交替手形，再用食指向前询问。',
          captionPosition: '角标提示',
          camera: '右侧 45°',
          commonMistakes: ['两手动作不同步', '疑问表情缺失'],
          exercise: '配合疑问表情完成三次询问。',
          exerciseFeedback: '录下动作，检查双手是否在胸前同一高度。',
          altText: '教师双手机械交替翻转后，食指朝前点出并抬眉疑问。',
          prerequisiteId: 'step-2-1',
          difficulty: '进阶',
          cuePoints: [5, 22, 37],
        },
      ],
    },
  ];

  // 学习路径：模块二第一个步骤以模块一最后的双人问候练习为前置
  const references: StepReference[] = [
    {
      id: 'ref-demo-1',
      stepId: 'step-2-1',
      ownerModuleId: 'module-2',
      targetStepId: 'step-1-3',
      targetModuleId: 'module-1',
      status: 'active',
      suspendReason: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  return {
    id: 'sign-course-project',
    title: '零基础手语 · 问候与数量',
    teacher: '陈老师 / 特殊教育中心',
    audience: '初次接触手语的初中学习者',
    status: 'draft',
    selectedModuleId: 'module-1',
    selectedStepId: 'step-1-2',
    modules,
    references,
    frozenVersions: [],
    lastSavedAt: new Date().toISOString(),
    revision: 2,
    schemaVersion: 2,
  };
}

export function selectedModule(project: CourseProject): CourseModule {
  return project.modules.find((module) => module.id === project.selectedModuleId) ?? project.modules[0];
}

export function selectedStep(project: CourseProject): LessonStep | undefined {
  const module = selectedModule(project);
  return module?.steps.find((step) => step.id === project.selectedStepId) ?? module?.steps[0];
}

export function findStep(project: CourseProject, moduleId: string, stepId: string): LessonStep | undefined {
  return project.modules.find((module) => module.id === moduleId)?.steps.find((step) => step.id === stepId);
}

export function findModuleOfStep(project: CourseProject, stepId: string): CourseModule | undefined {
  return project.modules.find((module) => module.steps.some((step) => step.id === stepId));
}

/** 步骤在学习路径中的全局次序：先模块顺序，再模块内步骤顺序 */
export function stepOrderKey(project: CourseProject, moduleId: string, stepId: string): number {
  const moduleIndex = project.modules.findIndex((module) => module.id === moduleId);
  const stepIndex = project.modules[moduleIndex]?.steps.findIndex((step) => step.id === stepId) ?? -1;
  if (moduleIndex < 0 || stepIndex < 0) return Number.POSITIVE_INFINITY;
  return moduleIndex * 1_000_000 + stepIndex;
}

export function referenceForStep(project: CourseProject, stepId: string): StepReference | undefined {
  return project.references.find((reference) => reference.stepId === stepId);
}

export function activeReferenceForStep(project: CourseProject, stepId: string): StepReference | undefined {
  const reference = referenceForStep(project, stepId);
  return reference && reference.status === 'active' ? reference : undefined;
}

/**
 * 重新核对所有跨模块引用：被引用步骤被删除或挪动到引用步骤之后时挂起。
 * 只在共享文档发生删除/挪动/重放后调用，已挂起的引用不会自动恢复，
 * 必须由引用方老师显式确认。
 */
export function reconcileReferences(
  project: CourseProject,
  hints: { deletedStepIds?: string[]; movedStepIds?: string[] } = {},
): { project: CourseProject; changed: StepReference[] } {
  const deleted = new Set(hints.deletedStepIds ?? []);
  const moved = new Set(hints.movedStepIds ?? []);
  const changed: StepReference[] = [];
  let didChange = false;

  const references = project.references.map((reference) => {
    if (reference.status === 'suspended') return reference;
    const target = findStep(project, reference.targetModuleId, reference.targetStepId);
    const ownerModule = project.modules.find((module) => module.id === reference.ownerModuleId);
    const ownerExists = ownerModule?.steps.some((step) => step.id === reference.stepId);
    let reason = '';

    if (!ownerExists) {
      // 引用方步骤本身已被删除，引用随之失效（清理，不挂起）
      didChange = true;
      changed.push(reference);
      return undefined as unknown as StepReference;
    }
    if (deleted.has(reference.targetStepId) || !target) {
      reason = '被引用的前置步骤已被对方老师删除';
    } else if (moved.has(reference.targetStepId)) {
      reason = '被引用的前置步骤被对方老师挪动了位置';
    } else if (stepOrderKey(project, reference.targetModuleId, reference.targetStepId)
      >= stepOrderKey(project, reference.ownerModuleId, reference.stepId)) {
      reason = '被引用步骤目前位于本步骤之后，学习顺序不成立';
    }
    if (reason) {
      didChange = true;
      const next: StepReference = {
        ...reference,
        status: 'suspended',
        suspendReason: reason,
        updatedAt: new Date().toISOString(),
      };
      changed.push(next);
      return next;
    }
    return reference;
  }).filter(Boolean);

  return { project: didChange ? { ...project, references } : project, changed };
}

export function validateProject(project: CourseProject, activeTeacherId?: TeacherId): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  if (!project.title.trim()) checks.push({ id: 'title', severity: 'error', title: '课程标题缺失', detail: '发布前需要为课程填写清晰标题。' });
  if (project.modules.length === 0) checks.push({ id: 'modules', severity: 'error', title: '没有课程模块', detail: '至少需要创建一个包含学习步骤的模块。' });

  project.modules.forEach((module) => {
    if (!module.steps.length) {
      checks.push({ id: `empty-${module.id}`, severity: 'error', title: `${module.title} 没有学习步骤`, detail: '空模块无法进入复核。', moduleId: module.id });
    }
    if (!module.ownerId) {
      checks.push({ id: `owner-${module.id}`, severity: 'warning', title: `${module.title} 尚未认领归属`, detail: '保存切片需要先有负责老师，点击模块卡片上的“认领”。', moduleId: module.id });
    }
    module.steps.forEach((step, index) => {
      if (!step.altText.trim()) {
        checks.push({ id: `alt-${step.id}`, severity: 'error', title: `${step.title} 缺少替代文本`, detail: '示范片段需要描述手形、移动和面部表情。', stepId: step.id, moduleId: module.id });
      }
      if (!step.caption.trim()) {
        checks.push({ id: `caption-${step.id}`, severity: 'warning', title: `${step.title} 缺少字幕`, detail: '听障学习者在静音预览时无法获得说明。', stepId: step.id, moduleId: module.id });
      }
      if (step.captionPosition === '画面中央' && (step.gestureZone === '中央' || step.camera === '俯拍手部')) {
        checks.push({ id: `overlap-${step.id}`, severity: 'error', title: `${step.title} 字幕可能遮挡动作`, detail: `字幕位于${step.captionPosition}，而主要手形位于${step.gestureZone}。`, stepId: step.id, moduleId: module.id });
      }
      if (step.duration < 20) {
        checks.push({ id: `duration-${step.id}`, severity: 'warning', title: `${step.title} 时长过短`, detail: '示范与练习不足 20 秒，学习者来不及观察和跟做。', stepId: step.id, moduleId: module.id });
      }
      if (step.prerequisiteId) {
        const prerequisiteIndex = module.steps.findIndex((candidate) => candidate.id === step.prerequisiteId);
        if (prerequisiteIndex < 0) {
          checks.push({ id: `missing-pre-${step.id}`, severity: 'error', title: `${step.title} 的前置步骤不存在`, detail: '请重新选择前置条件或移除依赖。', stepId: step.id, moduleId: module.id });
        } else if (prerequisiteIndex >= index) {
          checks.push({ id: `jump-${step.id}`, severity: 'error', title: `${step.title} 出现步骤跳级`, detail: '前置步骤位于当前步骤之后，学习顺序无法成立。', stepId: step.id, moduleId: module.id });
        }
      }
      if (step.kind === '练习' && (!step.exercise.trim() || !step.exerciseFeedback.trim())) {
        checks.push({ id: `practice-${step.id}`, severity: 'warning', title: `${step.title} 的练习反馈不完整`, detail: '练习任务需要明确完成动作和即时反馈方式。', stepId: step.id, moduleId: module.id });
      }
      if (step.commonMistakes.filter(Boolean).length === 0) {
        checks.push({ id: `mistakes-${step.id}`, severity: 'info', title: `${step.title} 尚未记录常见错误`, detail: '补充常见错误有助于教师现场提示。', stepId: step.id, moduleId: module.id });
      }
    });
  });

  // 跨模块学习路径检查
  project.references.forEach((reference) => {
    const ownerModule = project.modules.find((module) => module.id === reference.ownerModuleId);
    const step = ownerModule?.steps.find((item) => item.id === reference.stepId);
    const targetModule = project.modules.find((module) => module.id === reference.targetModuleId);
    const target = targetModule?.steps.find((item) => item.id === reference.targetStepId);
    const baseId = `xref-${reference.id}`;

    if (reference.status === 'suspended') {
      checks.push({
        id: baseId,
        severity: 'warning',
        title: `${step?.title ?? '学习步骤'} 的跨模块前置已挂起`,
        detail: `${reference.suspendReason}，需要本模块老师确认保留或解除引用。`,
        stepId: reference.stepId,
        moduleId: reference.ownerModuleId,
      });
      return;
    }
    if (!step || !target) {
      checks.push({ id: baseId, severity: 'error', title: '跨模块引用失效', detail: '引用方或被引用步骤不存在，请重新选择前置。', stepId: reference.stepId, moduleId: reference.ownerModuleId });
      return;
    }
    if (stepOrderKey(project, reference.targetModuleId, reference.targetStepId)
      >= stepOrderKey(project, reference.ownerModuleId, reference.stepId)) {
      checks.push({
        id: `${baseId}-order`,
        severity: 'error',
        title: `${step.title} 的跨模块前置跳级`,
        detail: `前置「${target.title}」位于本步骤之后，模块间学习顺序无法成立。`,
        stepId: step.id,
        moduleId: reference.ownerModuleId,
      });
    }
  });

  // 归属提示：当前老师只能编辑自己负责的模块
  if (activeTeacherId && activeTeacherId !== 'teacher-guest') {
    const owns = project.modules.filter((module) => module.ownerId === activeTeacherId);
    if (owns.length === 0) {
      checks.push({ id: 'no-ownership', severity: 'info', title: '当前身份没有归属模块', detail: '可认领未归属模块，或切换到负责模块一/模块二的老师身份。' });
    }
  }

  return checks;
}

export function cloneProject(project: CourseProject): CourseProject {
  return structuredClone(project);
}

/**
 * 迁移：把 v1（无归属、无引用表）的课程升级到 v2。
 * 老课程的模块一/模块二按顺序归属给两位老师，其余模块留空待认领；
 * 模块内部前置保持不变，跨模块引用在 v1 中不存在，因此从空表开始。
 * 返回 undefined 表示没有可迁移的数据。
 */
export function migrateLegacyProject(raw: string): CourseProject | undefined {
  let legacy: any;
  try {
    legacy = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!legacy || !Array.isArray(legacy.modules)) return undefined;
  if (legacy.schemaVersion === 2) return legacy as CourseProject;

  const ownerOrder: TeacherId[] = ['teacher-lin', 'teacher-zhao'];
  const nowIso = new Date().toISOString();

  const normalizeStep = (step: any): LessonStep & { __legacyPrerequisiteId: string } => ({
    id: String(step.id),
    title: String(step.title ?? ''),
    kind: step.kind === '示范' || step.kind === '讲解' || step.kind === '练习' ? step.kind : '示范',
    duration: Number(step.duration) || 0,
    demoTitle: String(step.demoTitle ?? ''),
    demoUrl: String(step.demoUrl ?? ''),
    handshape: String(step.handshape ?? ''),
    gestureZone: ['左侧', '中央', '右侧'].includes(step.gestureZone) ? step.gestureZone : '中央',
    caption: String(step.caption ?? ''),
    captionPosition: ['下方安全区', '上移 15%', '角标提示', '画面中央'].includes(step.captionPosition) ? step.captionPosition : '下方安全区',
    camera: ['正面', '左侧 45°', '右侧 45°', '俯拍手部', '全身远景'].includes(step.camera) ? step.camera : '正面',
    commonMistakes: Array.isArray(step.commonMistakes) ? step.commonMistakes.map(String) : [],
    exercise: String(step.exercise ?? ''),
    exerciseFeedback: String(step.exerciseFeedback ?? ''),
    altText: String(step.altText ?? ''),
    // v1 里前置 id 可能跨模块残留：本模块找不到的移入引用表
    prerequisiteId: '',
    difficulty: ['入门', '进阶', '挑战'].includes(step.difficulty) ? step.difficulty : '入门',
    cuePoints: Array.isArray(step.cuePoints) ? step.cuePoints.map(Number).filter(Number.isFinite) : [],
    __legacyPrerequisiteId: String(step.prerequisiteId ?? ''),
  });

  const toStep = (raw: any): LessonStep => {
    const withLegacy = normalizeStep(raw);
    const { __legacyPrerequisiteId: _drop, ...step } = withLegacy;
    void _drop;
    return step as LessonStep;
  };

  const modules: CourseModule[] = legacy.modules.map((module: any, index: number) => ({
    id: String(module.id ?? `module-${index + 1}`),
    title: String(module.title ?? `模块 ${index + 1}`),
    summary: String(module.summary ?? ''),
    color: String(module.color ?? '#15827a'),
    ownerId: ownerOrder[index] ?? '',
    steps: Array.isArray(module.steps) ? module.steps.map(toStep) : [],
  }));

  // 恢复模块内部前置；v1 中跨模块残留的前置转换为挂起引用，等待老师确认
  const references: StepReference[] = [];
  legacy.modules.forEach((legacyModule: any, moduleIndex: number) => {
    const module = modules[moduleIndex];
    const legacySteps: any[] = Array.isArray(legacyModule.steps) ? legacyModule.steps : [];
    legacySteps.forEach((legacyStep: any) => {
      const step = module.steps.find((item) => item.id === String(legacyStep.id));
      if (!step) return;
      const legacyPreId = String(legacyStep.prerequisiteId ?? '');
      if (!legacyPreId) return;
      if (module.steps.some((candidate) => candidate.id === legacyPreId)) {
        step.prerequisiteId = legacyPreId;
      } else {
        const targetModule = modules.find((candidate) => candidate.steps.some((item) => item.id === legacyPreId));
        if (targetModule) {
          references.push({
            id: `ref-migrated-${step.id}`,
            stepId: step.id,
            ownerModuleId: module.id,
            targetStepId: legacyPreId,
            targetModuleId: targetModule.id,
            status: 'suspended',
            suspendReason: '从旧版课程迁移的跨模块前置，请确认是否保留',
            createdAt: nowIso,
            updatedAt: nowIso,
          });
        }
      }
    });
  });

  const frozenVersions: FrozenVersion[] = Array.isArray(legacy.frozenVersions)
    ? legacy.frozenVersions.map((version: any): FrozenVersion | undefined => {
      if (!version?.snapshot) return undefined;
      // 冻结快照也升级到 v2，老快照仍可查看与修订
      const snapshot = migrateLegacyProject(JSON.stringify({ ...version.snapshot, frozenVersions: [] }));
      if (!snapshot) return undefined;
      return {
        id: String(version.id),
        label: String(version.label ?? '冻结版本'),
        createdAt: String(version.createdAt ?? nowIso),
        snapshot: { ...snapshot, frozenVersions: [] } as Omit<CourseProject, 'frozenVersions'>,
      };
    }).filter((version: FrozenVersion | undefined): version is FrozenVersion => Boolean(version))
    : [];

  return {
    id: String(legacy.id ?? 'sign-course-project'),
    title: String(legacy.title ?? '未命名课程'),
    teacher: String(legacy.teacher ?? ''),
    audience: String(legacy.audience ?? ''),
    status: ['draft', 'review', 'changes', 'frozen'].includes(legacy.status) ? legacy.status : 'draft',
    selectedModuleId: String(legacy.selectedModuleId ?? modules[0]?.id ?? ''),
    selectedStepId: String(legacy.selectedStepId ?? ''),
    modules,
    references,
    frozenVersions,
    lastSavedAt: String(legacy.lastSavedAt ?? nowIso),
    revision: Number(legacy.revision) || 1,
    schemaVersion: 2,
  };
}
