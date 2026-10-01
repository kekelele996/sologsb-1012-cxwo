import { Component, Host, State, h, Listen } from '@stencil/core';
import {
  activeReferenceForStep,
  cloneProject,
  createDemoProject,
  findModuleOfStep,
  findStep,
  referenceForStep,
  selectedModule,
  selectedStep,
  stepOrderKey,
  teacherById,
  TEACHERS,
  IDENTITY_KEY,
  validateProject,
  type CameraAngle,
  type CaptionPosition,
  type CourseModule,
  type CourseProject,
  type Difficulty,
  type GestureZone,
  type LessonStep,
  type OperationPayload,
  type PendingOperation,
  type StepReference,
  type TeacherId,
  type ValidationCheck,
} from '../../models';
import {
  SHARED_KEY,
  applyOperation,
  bootstrapShared,
  clientIdForTeacher,
  describeOperation,
  loadLocalState,
  loadOutbox,
  loadShared,
  pullShared,
  replayOutbox,
  saveLocalState,
  saveOutbox,
  saveSlice,
  type SharedDoc,
} from '../../collab';

type PreviewSize = 'phone' | 'tablet';

@Component({
  tag: 'app-root',
  styleUrl: 'app-root.css',
  scoped: true,
})
export class AppRoot {
  @State() project: CourseProject = createDemoProject();
  @State() previewSize: PreviewSize = 'phone';
  @State() activePanel: 'editor' | 'checks' = 'editor';
  @State() playing = false;
  @State() playProgress = 0;
  @State() offline = typeof navigator !== 'undefined' ? !navigator.onLine : false;
  @State() teacherId: TeacherId = 'teacher-lin';
  @State() outbox: PendingOperation[] = [];
  @State() showSyncCenter = false;
  @State() toast?: { color: string; message: string };
  private clientId = 'teacher-lin';
  private shared: SharedDoc;
  private past: CourseProject[] = [];
  private future: CourseProject[] = [];
  private playTimer?: number;

  constructor() {
    this.shared = bootstrapShared(createDemoProject());
  }

  componentWillLoad(): void {
    const savedTeacher = (localStorage.getItem(IDENTITY_KEY) as TeacherId | null);
    this.teacherId = savedTeacher && TEACHERS.some((teacher) => teacher.id === savedTeacher) ? savedTeacher : 'teacher-lin';
    this.clientId = clientIdForTeacher(this.teacherId);

    const local = loadLocalState(this.clientId);
    this.project = local
      ? pullShared(this.shared, local, this.teacherId)
      : pullShared(this.shared, cloneProject(this.shared.project), this.teacherId);
    this.project = this.reconcileLocal(this.project);
    this.outbox = loadOutbox(this.clientId);

    // 打开时如果浏览器在线，先把上次断网遗留的发件箱补回共享课程
    if (!this.offline && this.outbox.length > 0) {
      window.setTimeout(() => this.flushOutbox(true), 600);
    }
  }

  disconnectedCallback(): void {
    if (this.playTimer) window.clearInterval(this.playTimer);
  }

  @Listen('online', { target: 'window' })
  handleOnline(): void {
    this.offline = false;
    this.flushOutbox(true);
  }

  @Listen('offline', { target: 'window' })
  handleOffline(): void {
    this.offline = true;
    this.showToast('warning', '网络已断开，修改会继续保存在本机发件箱。');
  }

  /** 另一窗口写入共享文档时（另一位老师保存），在线且无待发改动的窗口立即拉取 */
  @Listen('storage', { target: 'window' })
  handleStorage(event: StorageEvent): void {
    if (event.key !== SHARED_KEY || this.offline) return;
    const doc = loadShared();
    if (!doc) return;
    this.shared = doc;
    this.project = this.reconcileLocal(pullShared(doc, this.project, this.teacherId));
  }

  @Listen('keydown', { target: 'window' })
  handleKeyboard(event: KeyboardEvent): void {
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName);
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.saveDraft(true);
      return;
    }
    if (!editing && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      this.moveStep(event.key === 'ArrowUp' ? -1 : 1);
    }
  }

  private get currentModule(): CourseModule {
    return selectedModule(this.project);
  }

  private get currentStep(): LessonStep | undefined {
    return selectedStep(this.project);
  }

  private get checks(): ValidationCheck[] {
    return validateProject(this.project, this.teacherId);
  }

  private get teacher() {
    return teacherById(this.teacherId);
  }

  private canEditModule(module: CourseModule | undefined): boolean {
    if (!module || this.project.status === 'frozen') return false;
    return module.ownerId === this.teacherId;
  }

  /** 本窗口工作副本上重新核对引用：对方老师的删除/挪动（从共享拉取后）会把引用挂起 */
  private reconcileLocal(project: CourseProject): CourseProject {
    const local = reconcileForPull(project);
    return local;
  }

  private persistWorking(next: CourseProject): void {
    this.project = next;
    saveLocalState(this.clientId, next);
  }

  /**
   * 所有写操作的统一入口：
   * - 在线：直接补进共享文档（幂等，已一致的不动），再把归属外的切片拉回工作副本；
   * - 离线：先进本窗口发件箱，工作副本照常更新，网络恢复后回放。
   */
  private dispatch(label: string, payload: OperationPayload, mutate: (draft: CourseProject) => CourseProject, toast?: string): void {
    const before = cloneProject(this.project);
    const stamp = new Date().toISOString();
    let next = mutate(cloneProject(this.project));
    next = { ...next, revision: next.revision + 1, lastSavedAt: stamp };

    if (this.offline) {
      const op: PendingOperation = {
        id: `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        clientId: this.clientId,
        teacherId: this.teacherId,
        at: stamp,
        label,
        payload,
      };
      this.outbox = [...this.outbox, op];
      saveOutbox(this.clientId, this.outbox);
    } else {
      const result = applyOperation(this.shared.project, {
        id: `op-${Date.now().toString(36)}`, clientId: this.clientId, teacherId: this.teacherId, at: stamp, label, payload,
      });
      let sharedProject = result.project;
      const hints = payloadHints(payload);
      if (hints.deletedStepIds?.length || hints.movedStepIds?.length) {
        sharedProject = this.reconcileAfterMutation(sharedProject, hints);
      }
      this.shared = { project: sharedProject, updatedAt: stamp };
      saveSlice(this.shared, next, this.teacherId);
      this.shared = loadShared() ?? this.shared;
      next = pullShared(this.shared, next, this.teacherId);
    }

    next = this.reconcileLocal(next);
    this.past = [...this.past, before].slice(-80);
    this.future = [];
    this.persistWorking(next);
    if (toast) this.showToast('success', this.offline ? `${toast}（已进入离线发件箱）` : toast);
  }

  private reconcileAfterMutation(project: CourseProject, hints: { deletedStepIds?: string[]; movedStepIds?: string[] }): CourseProject {
    // 复用 models 中的引用核对（通过内联实现，避免循环依赖）
    return reconcileRefsInline(project, hints);
  }

  private flushOutbox(showMessage = false): void {
    if (this.outbox.length === 0) {
      if (showMessage) this.showToast('success', '本地改动都已在课程中，没有需要补回的内容。');
      return;
    }
    const pending = this.outbox;
    const result = replayOutbox(this.shared, pending);
    this.shared = result.doc;
    this.project = this.reconcileLocal(pullShared(result.doc, this.project, this.teacherId));
    this.outbox = [];
    saveOutbox(this.clientId, []);
    this.persistWorking(this.project);
    if (showMessage) {
      const suspended = result.suspendedRefs.length;
      const message = `网络恢复：已补回 ${result.applied} 项改动，${result.skipped} 项已与课程一致未重复写入。`
        + (suspended ? ` 另有 ${suspended} 条跨模块前置引用已挂起，请确认。` : '');
      this.showToast(suspended ? 'warning' : 'success', message);
    }
  }

  private switchTeacher(teacherId: TeacherId): void {
    if (teacherId === this.teacherId) return;
    this.teacherId = teacherId;
    this.clientId = clientIdForTeacher(teacherId);
    localStorage.setItem(IDENTITY_KEY, teacherId);
    this.past = [];
    this.future = [];
    this.outbox = loadOutbox(this.clientId);
    const local = loadLocalState(this.clientId);
    this.project = this.reconcileLocal(local
      ? pullShared(this.shared, local, teacherId)
      : pullShared(this.shared, cloneProject(this.shared.project), teacherId));
    if (!this.offline && this.outbox.length) this.flushOutbox(true);
  }

  private toggleOffline(): void {
    this.offline = !this.offline;
    if (this.offline) {
      this.showToast('warning', '已进入离线模拟，编辑照常保存到本机发件箱。');
    } else {
      this.showToast('success', '已恢复在线，正在补回断网期间的改动…');
      this.flushOutbox(true);
    }
  }

  private showToast(color: string, message: string): void {
    this.toast = { color, message };
    window.setTimeout(() => {
      if (this.toast?.message === message) this.toast = undefined;
    }, 3_600);
  }

  private selectModule(moduleId: string): void {
    const module = this.project.modules.find((item) => item.id === moduleId);
    const next = { ...this.project, selectedModuleId: moduleId, selectedStepId: module?.steps[0]?.id ?? '' };
    this.persistWorking(next);
  }

  private selectStep(stepId: string): void {
    this.persistWorking({ ...this.project, selectedStepId: stepId });
  }

  private updateStep(patch: Partial<LessonStep>, toast?: string): void {
    const stepId = this.currentStep?.id;
    const moduleId = this.currentModule?.id;
    if (!stepId || !moduleId || !this.canEditModule(this.currentModule)) return;
    this.dispatch('编辑学习步骤', { type: 'patchStep', moduleId, stepId, fields: patch }, (draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === moduleId ? {
        ...module,
        steps: module.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step),
      } : module),
    }), toast);
  }

  private updateCurrentModule(patch: Partial<CourseModule>): void {
    const moduleId = this.currentModule?.id;
    if (!moduleId || !this.canEditModule(this.currentModule)) return;
    this.dispatch('修改模块信息', { type: 'patchModule', moduleId, fields: patch }, (draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === moduleId ? { ...module, ...patch } : module),
    }));
  }

  private updateCourse(fields: Partial<Pick<CourseProject, 'title' | 'teacher' | 'audience'>>): void {
    if (this.project.status === 'frozen') return;
    this.dispatch('修改课程信息', { type: 'patchCourse', fields }, (draft) => ({ ...draft, ...fields }));
  }

  private claimModule(moduleId: string): void {
    if (this.teacherId === 'teacher-guest') {
      this.showToast('warning', '访客身份不能认领模块，请先切换到老师身份。');
      return;
    }
    this.dispatch('认领模块归属', { type: 'claimModule', moduleId, ownerId: this.teacherId }, (draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === moduleId ? { ...module, ownerId: this.teacherId } : module),
    }), `已由${this.teacher.name}认领该模块。`);
  }

  private addModule(): void {
    if (this.teacherId === 'teacher-guest') return this.showToast('warning', '访客身份不能创建模块。');
    const index = this.project.modules.length + 1;
    const module: CourseModule = {
      id: `module-${Date.now().toString(36)}`,
      title: `模块 ${index} · 未命名`,
      summary: '说明该模块的学习目标与适用场景。',
      color: ['#15827a', '#8a3ffc', '#b34331', '#376ea8'][index % 4],
      ownerId: this.teacherId,
      steps: [],
    };
    this.dispatch('新建课程模块', { type: 'addModule', module }, (draft) => ({
      ...draft, modules: [...draft.modules, module], selectedModuleId: module.id, selectedStepId: '',
    }), '已创建课程模块。');
  }

  private addStep(kind: LessonStep['kind'] = '示范'): void {
    const module = this.currentModule;
    if (!module) return this.addModule();
    if (!this.canEditModule(module)) {
      this.showToast('warning', `${module.title}归${teacherById(module.ownerId || 'teacher-guest').name}负责，当前身份只能查看。`);
      return;
    }
    const prior = module.steps.at(-1);
    const step: LessonStep = {
      id: `step-${Date.now().toString(36)}`,
      title: `新${kind}步骤 ${module.steps.length + 1}`,
      kind,
      duration: 45,
      demoTitle: '等待上传或录制示范片段',
      demoUrl: '',
      handshape: '描述起始手形、掌心方向和运动路径。',
      gestureZone: '中央',
      caption: '填写送给学习者的字幕说明。',
      captionPosition: '下方安全区',
      camera: '正面',
      commonMistakes: [],
      exercise: kind === '练习' ? '填写练习任务。' : '',
      exerciseFeedback: kind === '练习' ? '填写反馈方式。' : '',
      altText: '',
      prerequisiteId: prior?.id ?? '',
      difficulty: '入门',
      cuePoints: [8, 20, 32],
    };
    this.dispatch('新增学习步骤', { type: 'addStep', moduleId: module.id, step }, (draft) => ({
      ...draft,
      modules: draft.modules.map((item) => item.id === module.id ? { ...item, steps: [...item.steps, step] } : item),
      selectedStepId: step.id,
    }), '已新增学习步骤。');
  }

  private duplicateStep(): void {
    const step = this.currentStep;
    const moduleId = this.currentModule?.id;
    if (!step || !moduleId || !this.canEditModule(this.currentModule)) return;
    const duplicate: LessonStep = { ...structuredClone(step), id: `step-${Date.now().toString(36)}`, title: `${step.title}（副本）` };
    this.dispatch('复制学习步骤', { type: 'addStep', moduleId, step: duplicate }, (draft) => ({
      ...draft,
      modules: draft.modules.map((module) => {
        if (module.id !== moduleId) return module;
        const index = module.steps.findIndex((item) => item.id === step.id);
        return { ...module, steps: [...module.steps.slice(0, index + 1), duplicate, ...module.steps.slice(index + 1)] };
      }),
    }), '已复制当前步骤。');
  }

  private deleteStep(stepId: string): void {
    const moduleId = this.currentModule?.id;
    if (!moduleId || !this.canEditModule(this.currentModule)) return;
    if (this.currentModule.steps.length <= 1) {
      this.showToast('warning', '模块至少保留一个学习步骤。');
      return;
    }
    const incomingCount = this.project.references.filter((reference) => reference.targetStepId === stepId).length;
    const hint = incomingCount > 0 ? `该步骤被 ${incomingCount} 条跨模块前置引用，删除后对方老师会看到引用挂起。` : undefined;
    if (incomingCount > 0 && !window.confirm(`${hint}\n\n确认删除？`)) return;

    this.dispatch('删除学习步骤', { type: 'deleteStep', moduleId, stepId }, (draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === moduleId ? {
        ...module,
        steps: module.steps.filter((step) => step.id !== stepId),
      } : module),
      references: draft.references.filter((reference) => reference.stepId !== stepId),
      selectedStepId: this.currentModule.steps.find((step) => step.id !== stepId)?.id ?? '',
    }), hint ?? '已删除学习步骤。');
  }

  private moveStep(direction: number): void {
    const stepId = this.currentStep?.id;
    const moduleId = this.currentModule?.id;
    if (!stepId || !moduleId || !this.canEditModule(this.currentModule)) return;
    this.dispatch('调整步骤顺序', { type: 'moveStep', moduleId, stepId, direction: direction > 0 ? 1 : -1 }, (draft) => ({
      ...draft,
      modules: draft.modules.map((module) => {
        if (module.id !== moduleId) return module;
        const index = module.steps.findIndex((step) => step.id === stepId);
        const nextIndex = Math.max(0, Math.min(module.steps.length - 1, index + direction));
        if (index === nextIndex) return module;
        const steps = [...module.steps];
        const [item] = steps.splice(index, 1);
        steps.splice(nextIndex, 0, item);
        return { ...module, steps };
      }),
    }), '已调整步骤顺序。');
  }

  // —— 跨模块学习路径 ——

  private setInternalPrerequisite(prerequisiteId: string): void {
    this.updateStep({ prerequisiteId });
  }

  private setCrossModulePrerequisite(targetRef: string): void {
    const step = this.currentStep;
    const ownerModule = this.currentModule;
    if (!step || !ownerModule || !this.canEditModule(ownerModule)) return;

    if (!targetRef) {
      const existing = referenceForStep(this.project, step.id);
      if (existing) {
        this.dispatch('解除跨模块引用', { type: 'resolveReference', referenceId: existing.id, action: 'remove' }, (draft) => ({
          ...draft,
          references: draft.references.filter((reference) => reference.id !== existing.id),
        }), '已解除跨模块前置。');
      }
      return;
    }

    const [targetModuleId, targetStepId] = targetRef.split('::');
    const existing = referenceForStep(this.project, step.id);
    const stamp = new Date().toISOString();
    const reference: StepReference = {
      id: existing?.id ?? `ref-${Date.now().toString(36)}`,
      stepId: step.id,
      ownerModuleId: ownerModule.id,
      targetStepId,
      targetModuleId,
      status: 'active',
      suspendReason: '',
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
    };
    this.dispatch('建立跨模块前置引用', { type: 'addReference', reference }, (draft) => ({
      ...draft,
      references: [...draft.references.filter((item) => item.stepId !== step.id), reference],
    }), '已连接模块间学习路径。');
  }

  private resolveReference(referenceId: string, action: 'reaffirm' | 'remove'): void {
    if (!this.canEditModule(this.currentModule)) return;
    this.dispatch(action === 'remove' ? '解除跨模块引用' : '确认保留跨模块引用',
      { type: 'resolveReference', referenceId, action },
      (draft) => ({
        ...draft,
        references: action === 'remove'
          ? draft.references.filter((reference) => reference.id !== referenceId)
          : draft.references.map((reference) => reference.id === referenceId
            ? { ...reference, status: 'active', suspendReason: '', updatedAt: new Date().toISOString() }
            : reference),
      }),
      action === 'remove' ? '已解除跨模块前置。' : '已确认保留，跨模块前置恢复有效。');
  }

  // —— 撤销 / 重做：把当时快照相对当前的归属模块改动与课程字段差异补回 ——

  private buildRestoreOps(from: CourseProject, to: CourseProject): OperationPayload[] {
    const ops: OperationPayload[] = [];
    const ownedIds = new Set(to.modules.filter((module) => module.ownerId === this.teacherId).map((module) => module.id));
    from.modules.forEach((module) => {
      if (!ownedIds.has(module.id) && module.ownerId !== this.teacherId) return;
      const target = to.modules.find((item) => item.id === module.id);
      if (target && target.ownerId === this.teacherId) ops.push({ type: 'replaceModule', module: structuredClone(target) });
      if (!target && module.ownerId === this.teacherId) ops.push({ type: 'removeModule', moduleId: module.id });
    });
    to.modules.forEach((module) => {
      if (module.ownerId === this.teacherId && !from.modules.some((item) => item.id === module.id)) {
        ops.push({ type: 'replaceModule', module: structuredClone(module) });
      }
    });
    if (from.title !== to.title || from.teacher !== to.teacher || from.audience !== to.audience || from.status !== to.status) {
      ops.push({ type: 'patchCourse', fields: { title: to.title, teacher: to.teacher, audience: to.audience, status: to.status } });
    }
    const fromRefs = new Map(from.references.filter((r) => this.ownsReference(to, r.stepId)).map((r) => [r.id, r]));
    const toRefs = new Map(to.references.filter((r) => this.ownsReference(to, r.stepId)).map((r) => [r.id, r]));
    toRefs.forEach((reference, id) => {
      if (JSON.stringify(fromRefs.get(id)) !== JSON.stringify(reference)) {
        ops.push({ type: 'addReference', reference: structuredClone(reference) });
      }
    });
    fromRefs.forEach((_reference, id) => {
      if (!toRefs.has(id)) ops.push({ type: 'resolveReference', referenceId: id, action: 'remove' });
    });
    return ops;
  }

  private ownsReference(project: CourseProject, stepId: string): boolean {
    return findModuleOfStep(project, stepId)?.ownerId === this.teacherId;
  }

  private restoreSnapshot(target: CourseProject): void {
    const ops = this.buildRestoreOps(this.project, target);
    if (ops.length === 0) {
      this.persistWorking(target);
      return;
    }
    let sharedProject = this.shared.project;
    const stamp = new Date().toISOString();
    ops.forEach((payload, index) => {
      const result = applyOperation(sharedProject, {
        id: `op-undo-${Date.now().toString(36)}-${index}`, clientId: this.clientId, teacherId: this.teacherId, at: stamp, label: '撤销/重做', payload,
      });
      sharedProject = result.project;
      const hints = payloadHints(payload);
      if (hints.deletedStepIds?.length || hints.movedStepIds?.length) {
        sharedProject = reconcileRefsInline(sharedProject, hints);
      }
    });
    if (this.offline) {
      const pending: PendingOperation[] = ops.map((payload, index) => ({
        id: `op-undo-${Date.now().toString(36)}-${index}`, clientId: this.clientId, teacherId: this.teacherId, at: stamp, label: '撤销/重做', payload,
      }));
      this.outbox = [...this.outbox, ...pending];
      saveOutbox(this.clientId, this.outbox);
    } else {
      this.shared = { project: sharedProject, updatedAt: stamp };
      saveSlice(this.shared, target, this.teacherId);
      this.shared = loadShared() ?? this.shared;
    }
    let next = this.offline ? target : pullShared(this.shared, target, this.teacherId);
    next = this.reconcileLocal(next);
    this.persistWorking(next);
  }

  private undo(): void {
    const previous = this.past.pop();
    if (!previous) return this.showToast('medium', '没有可撤销的修改。');
    this.future = [cloneProject(this.project), ...this.future].slice(0, 80);
    this.restoreSnapshot(previous);
  }

  private redo(): void {
    const next = this.future.shift();
    if (!next) return;
    this.past = [...this.past, cloneProject(this.project)].slice(-80);
    this.restoreSnapshot(next);
  }

  private saveDraft(showMessage = true): void {
    if (this.project.status === 'frozen') {
      this.showToast('warning', '冻结版本不可覆盖，请先创建修订版。');
      return;
    }
    if (this.offline) {
      // 离线时所有编辑已逐条进入发件箱，保存仅刷新本地草稿
      this.persistWorking({ ...this.project, status: 'draft', lastSavedAt: new Date().toISOString() });
      if (showMessage) this.showToast('warning', `离线中：草稿已在本机保存，发件箱还有 ${this.outbox.length} 项待网络恢复后补回。`);
      return;
    }
    const stamped = { ...this.project, status: 'draft' as const, lastSavedAt: new Date().toISOString() };
    this.shared = saveSlice(this.shared, stamped, this.teacherId);
    this.persistWorking(pullShared(this.shared, stamped, this.teacherId));
    if (showMessage) this.showToast('success', `切片已保存：只更新${this.teacher.name}负责的模块，另一位老师的模块保持不动。`);
  }

  private submitForReview(): void {
    const blocking = this.checks.filter((check) => check.severity === 'error');
    if (blocking.length) {
      this.activePanel = 'checks';
      this.showToast('danger', `仍有 ${blocking.length} 个阻断问题，修复后才能提交复核。`);
      return;
    }
    this.dispatch('提交复核', { type: 'patchCourse', fields: { status: 'review' } }, (draft) => ({ ...draft, status: 'review' }), '课程已提交复核。');
  }

  private returnForChanges(): void {
    this.dispatch('退回修改', { type: 'patchCourse', fields: { status: 'changes' } }, (draft) => ({ ...draft, status: 'changes' }), '课程已退回修改。');
  }

  private freezeVersion(): void {
    const blocking = this.checks.filter((check) => check.severity === 'error');
    if (blocking.length) {
      this.activePanel = 'checks';
      this.showToast('danger', `冻结前仍有 ${blocking.length} 个阻断问题。`);
      return;
    }
    const stamp = new Date().toISOString();
    const { frozenVersions, ...snapshot } = cloneProject({ ...this.project, status: 'frozen' as const });
    const version = {
      id: `frozen-${Date.now().toString(36)}`,
      label: `冻结版本 v${frozenVersions.length + 1}`,
      createdAt: stamp,
      snapshot,
    };
    this.dispatch('冻结课程版本', { type: 'addFrozen', version }, (draft) => ({
      ...draft, status: 'frozen', frozenVersions: [version, ...draft.frozenVersions],
    }), '当前课程版本已冻结。');
    this.playing = false;
  }

  private reviseFrozen(): void {
    this.dispatch('创建修订版', { type: 'patchCourse', fields: { status: 'draft' } }, (draft) => ({ ...draft, status: 'draft' }), '已创建修订版，可继续编辑。');
  }

  private togglePlay(): void {
    if (this.playTimer) {
      window.clearInterval(this.playTimer);
      this.playTimer = undefined;
      this.playing = false;
      return;
    }
    const duration = Math.max(10, this.currentStep?.duration ?? 40);
    this.playing = true;
    this.playTimer = window.setInterval(() => {
      this.playProgress += 0.25 / duration;
      if (this.playProgress >= 1) {
        this.playProgress = 0;
        this.playing = false;
        if (this.playTimer) window.clearInterval(this.playTimer);
        this.playTimer = undefined;
      }
    }, 250);
  }

  private formatDate(value: string): string {
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  private renderStatusBadge() {
    if (this.project.status === 'review') return <ion-badge color="warning">待复核</ion-badge>;
    if (this.project.status === 'frozen') return <ion-badge color="success">已冻结</ion-badge>;
    if (this.project.status === 'changes') return <ion-badge color="danger">已退回</ion-badge>;
    return <ion-badge color="medium">草稿</ion-badge>;
  }

  private renderStepListItem(step: LessonStep, index: number) {
    const active = step.id === this.currentStep?.id;
    const issueCount = this.checks.filter((check) => check.stepId === step.id && check.severity !== 'info').length;
    const suspended = referenceForStep(this.project, step.id)?.status === 'suspended';
    const xref = activeReferenceForStep(this.project, step.id);
    const target = xref ? findStep(this.project, xref.targetModuleId, xref.targetStepId) : undefined;
    return (
      <button class={`step-list-item ${active ? 'active' : ''}`} onClick={() => this.selectStep(step.id)}>
        <span class="step-index">{String(index + 1).padStart(2, '0')}</span>
        <span class="step-copy">
          <strong>{step.title}</strong>
          <small>{step.kind} · {step.duration}s · {step.difficulty}{target ? ' · 🔗跨模块前置' : ''}{suspended ? ' · ⚠引用挂起' : ''}</small>
        </span>
        {issueCount > 0 && <span class="step-issue-count">{issueCount}</span>}
      </button>
    );
  }

  private renderPrerequisiteEditor(step: LessonStep) {
    const module = this.currentModule;
    const editable = this.canEditModule(module);
    const internalCandidates = module.steps.filter((candidate) => candidate.id !== step.id);
    const xref = referenceForStep(this.project, step.id);
    const activeXref = activeReferenceForStep(this.project, step.id);
    const crossValue = activeXref ? `${activeXref.targetModuleId}::${activeXref.targetStepId}` : '';

    const crossCandidates = this.project.modules
      .filter((item) => item.id !== module.id)
      .flatMap((item) => item.steps.map((candidate) => ({ module: item, step: candidate })))
      // 只列出学习路径上位于本步骤之前的候选，避免直接选成跳级
      .filter(({ module: targetModule, step: targetStep }) =>
        stepOrderKey(this.project, targetModule.id, targetStep.id) < stepOrderKey(this.project, module.id, step.id));

    return (
      <div class="prerequisite-block">
        <div class="form-grid two">
          <ion-select disabled={!editable} label="模块内前置" labelPlacement="stacked" class="studio-input"
            value={step.prerequisiteId} onIonChange={(event) => this.setInternalPrerequisite(event.detail.value ?? '')}>
            <ion-select-option value="">无</ion-select-option>
            {internalCandidates.map((item) => <ion-select-option value={item.id}>{item.title}</ion-select-option>)}
          </ion-select>
          <ion-select disabled={!editable} label="跨模块前置（模块一 ↔ 模块二学习路径）" labelPlacement="stacked" class="studio-input"
            value={crossValue} onIonChange={(event) => this.setCrossModulePrerequisite(event.detail.value ?? '')}>
            <ion-select-option value="">不连接其他模块</ion-select-option>
            {crossCandidates.map(({ module: targetModule, step: targetStep }) => (
              <ion-select-option value={`${targetModule.id}::${targetStep.id}`}>{targetModule.title} / {targetStep.title}</ion-select-option>
            ))}
          </ion-select>
        </div>
        {xref?.status === 'suspended' && (
          <div class="ref-suspended-callout">
            <div>
              <strong>跨模块前置已挂起，等待你确认</strong>
              <span>{xref.suspendReason}。对方老师负责的步骤不会被你这边的编辑改动，引用暂时不参与学习路径校验。</span>
            </div>
            <div class="ref-actions">
              <ion-button size="small" fill="outline" color="danger" class="studio-button" onClick={() => this.resolveReference(xref.id, 'remove')}>解除引用</ion-button>
              <ion-button size="small" class="studio-button" onClick={() => this.resolveReference(xref.id, 'reaffirm')}>确认保留</ion-button>
            </div>
          </div>
        )}
        {activeXref && (() => {
          const target = findStep(this.project, activeXref.targetModuleId, activeXref.targetStepId);
          const targetModule = this.project.modules.find((item) => item.id === activeXref.targetModuleId);
          return (
            <p class="ref-active-note">🔗 学习路径：先完成「{targetModule?.title} / {target?.title ?? '步骤已不存在'}」，再进入本步骤。</p>
          );
        })()}
      </div>
    );
  }

  private renderStepEditor() {
    const step = this.currentStep;
    if (!step) {
      return (
        <div class="empty-editor">
          <div class="empty-glyph">手</div>
          <h2>这个模块还没有学习步骤</h2>
          <p>添加示范、讲解或练习步骤，然后设置模块内与跨模块前置条件。</p>
          <ion-button class="studio-button" onClick={() => this.addStep('示范')}>添加第一个步骤</ion-button>
        </div>
      );
    }
    const frozen = this.project.status === 'frozen';
    const module = this.currentModule;
    const editable = this.canEditModule(module);
    const ownership = teacherById(module.ownerId || 'teacher-guest');
    return (
      <div class="step-editor">
        <div class="editor-title-row">
          <div>
            <span class="eyebrow">学习步骤 {module.steps.findIndex((item) => item.id === step.id) + 1}</span>
            <h1>{step.title}</h1>
            <p>最后修改 {this.formatDate(this.project.lastSavedAt)} · 共享修订号 {this.shared.project.revision}</p>
          </div>
          <div class="title-actions">
            <ion-button fill="clear" class="studio-button" disabled={!editable} onClick={() => this.moveStep(-1)} title="Alt + ↑">上移</ion-button>
            <ion-button fill="clear" class="studio-button" disabled={!editable} onClick={() => this.moveStep(1)} title="Alt + ↓">下移</ion-button>
            <ion-button fill="outline" class="studio-button" disabled={!editable} onClick={() => this.duplicateStep()}>复制</ion-button>
            <ion-button fill="outline" color="danger" class="studio-button" disabled={!editable} onClick={() => this.deleteStep(step.id)}>删除</ion-button>
          </div>
        </div>

        {!editable && (
          <div class="lock-callout">
            <div><strong>{frozen ? '此版本已冻结' : `只读模块 · 归属${ownership.name}`}</strong>
              <span>{frozen ? '字段已锁定，仍可预览和运行检查。' : `该模块由${ownership.name}负责，本窗口（${this.teacher.name}）只能查看，避免覆盖对方改动。`}</span></div>
            {frozen
              ? <ion-button size="small" class="studio-button" onClick={() => this.reviseFrozen()}>创建修订版</ion-button>
              : !module.ownerId
                ? <ion-button size="small" class="studio-button" onClick={() => this.claimModule(module.id)}>认领该模块</ion-button>
                : null}
          </div>
        )}

        <section class="form-card">
          <div class="section-title"><span>01</span><div><h2>基础设计</h2><p>标题、类型、难度和预计时长</p></div></div>
          <div class="form-grid two">
            <ion-input disabled={!editable} label="步骤标题" labelPlacement="stacked" class="studio-input" value={step.title} onIonInput={(event) => this.updateStep({ title: event.detail.value ?? '' })} />
            <ion-select disabled={!editable} label="步骤类型" labelPlacement="stacked" class="studio-input" value={step.kind} onIonChange={(event) => this.updateStep({ kind: event.detail.value as LessonStep['kind'] })}>
              <ion-select-option value="示范">示范</ion-select-option>
              <ion-select-option value="讲解">讲解</ion-select-option>
              <ion-select-option value="练习">练习</ion-select-option>
            </ion-select>
            <ion-select disabled={!editable} label="难度标签" labelPlacement="stacked" class="studio-input" value={step.difficulty} onIonChange={(event) => this.updateStep({ difficulty: event.detail.value as Difficulty })}>
              {(['入门', '进阶', '挑战'] as Difficulty[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={!editable} type="number" min="10" max="600" label="预计时长（秒）" labelPlacement="stacked" class="studio-input" value={String(step.duration)} onIonInput={(event) => this.updateStep({ duration: Number(event.detail.value) || 0 })} />
          </div>
        </section>

        <section class="form-card">
          <div class="section-title"><span>02</span><div><h2>示范片段与镜头</h2><p>记录素材标识、手形、镜头角度和动作区域</p></div></div>
          <div class="demo-row">
            <div class={`video-thumbnail zone-${step.gestureZone}`}>
              <span class="play-mark">▶</span>
              <strong>{step.kind}片段</strong>
              <small>{step.camera}</small>
            </div>
            <div class="demo-fields">
              <ion-input disabled={!editable} label="示范片段名称" labelPlacement="stacked" class="studio-input" value={step.demoTitle} onIonInput={(event) => this.updateStep({ demoTitle: event.detail.value ?? '' })} />
              <ion-input disabled={!editable} label="本地素材地址（可空）" labelPlacement="stacked" class="studio-input" value={step.demoUrl} placeholder="例如 assets/hello.mp4" onIonInput={(event) => this.updateStep({ demoUrl: event.detail.value ?? '' })} />
            </div>
          </div>
          <div class="form-grid two">
            <ion-select disabled={!editable} label="镜头角度" labelPlacement="stacked" class="studio-input" value={step.camera} onIonChange={(event) => this.updateStep({ camera: event.detail.value as CameraAngle })}>
              {(['正面', '左侧 45°', '右侧 45°', '俯拍手部', '全身远景'] as CameraAngle[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-select disabled={!editable} label="主要手形区域" labelPlacement="stacked" class="studio-input" value={step.gestureZone} onIonChange={(event) => this.updateStep({ gestureZone: event.detail.value as GestureZone })}>
              {(['左侧', '中央', '右侧'] as GestureZone[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
          </div>
          <ion-textarea disabled={!editable} autoGrow label="手形说明" labelPlacement="stacked" class="studio-input" value={step.handshape} onIonInput={(event) => this.updateStep({ handshape: event.detail.value ?? '' })} />
        </section>

        <section class="form-card">
          <div class="section-title"><span>03</span><div><h2>字幕与无障碍</h2><p>检查字幕位置、动作遮挡与替代文本</p></div></div>
          <div class="form-grid two">
            <ion-select disabled={!editable} label="字幕位置" labelPlacement="stacked" class="studio-input" value={step.captionPosition} onIonChange={(event) => this.updateStep({ captionPosition: event.detail.value as CaptionPosition })}>
              {(['下方安全区', '上移 15%', '角标提示', '画面中央'] as CaptionPosition[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-input disabled label="替代文本状态" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText ? '已填写' : '缺失'} readonly />
          </div>
          <ion-textarea disabled={!editable} autoGrow label="步骤字幕" labelPlacement="stacked" class="studio-input" value={step.caption} onIonInput={(event) => this.updateStep({ caption: event.detail.value ?? '' })} />
          <ion-textarea disabled={!editable} autoGrow label="替代文本（必须描述动作与表情）" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText} onIonInput={(event) => this.updateStep({ altText: event.detail.value ?? '' })} />
        </section>

        <section class="form-card">
          <div class="section-title"><span>04</span><div><h2>学习依赖与练习</h2><p>模块内前置、跨模块前置、常见错误与练习任务</p></div></div>
          {this.renderPrerequisiteEditor(step)}
          <div class="form-grid two">
            <ion-input disabled={!editable} label="检查点（秒，用逗号分隔）" labelPlacement="stacked" class="studio-input" value={step.cuePoints.join(', ')} onIonInput={(event) => this.updateStep({ cuePoints: (event.detail.value ?? '').split(/[,，\s]+/).map(Number).filter((value) => Number.isFinite(value)) })} />
          </div>
          <ion-textarea disabled={!editable} autoGrow label="常见错误（每行一条）" labelPlacement="stacked" class="studio-input" value={step.commonMistakes.join('\n')} onIonInput={(event) => this.updateStep({ commonMistakes: (event.detail.value ?? '').split('\n').filter(Boolean) })} />
          <div class="form-grid two">
            <ion-textarea disabled={!editable} autoGrow label="练习任务" labelPlacement="stacked" class="studio-input" value={step.exercise} onIonInput={(event) => this.updateStep({ exercise: event.detail.value ?? '' })} />
            <ion-textarea disabled={!editable} autoGrow label="练习反馈" labelPlacement="stacked" class="studio-input" value={step.exerciseFeedback} onIonInput={(event) => this.updateStep({ exerciseFeedback: event.detail.value ?? '' })} />
          </div>
        </section>
      </div>
    );
  }

  private renderPreview() {
    const step = this.currentStep;
    const progress = Math.round(this.playProgress * 100);
    const xref = step ? activeReferenceForStep(this.project, step.id) : undefined;
    const xrefTarget = xref ? findStep(this.project, xref.targetModuleId, xref.targetStepId) : undefined;
    const xrefModule = xref ? this.project.modules.find((item) => item.id === xref.targetModuleId) : undefined;
    return (
      <section class="preview-panel">
        <div class="preview-head">
          <div><span class="eyebrow">学习者预览</span><h2>设备与安全区检查</h2></div>
          <ion-segment value={this.previewSize} class="studio-segment" onIonChange={(event) => { this.previewSize = event.detail.value as PreviewSize; }}>
            <ion-segment-button value="phone">手机</ion-segment-button>
            <ion-segment-button value="tablet">平板</ion-segment-button>
          </ion-segment>
        </div>
        {step ? (
          <div class={`device-frame ${this.previewSize}`}>
            <div class="device-top"><span>{this.previewSize === 'phone' ? '9:16' : '4:3'}</span><span>{step.camera}</span></div>
            <div class={`preview-stage zone-${step.gestureZone} caption-${step.captionPosition.replace(/\s|%/g, '')} ${step.captionPosition === '画面中央' && step.gestureZone === '中央' ? 'overlap-warning' : ''}`}>
              <div class="stage-grid" />
              <div class="signer">
                <div class="head"><span class="face"><i /><i /></span></div>
                <div class="torso" />
                <div class="arm arm-left"><span class="hand" /></div>
                <div class="arm arm-right"><span class="hand" /></div>
              </div>
              <div class="gesture-marker" style={{ left: step.gestureZone === '左侧' ? '18%' : step.gestureZone === '右侧' ? '70%' : '43%' }} />
              <div class="caption-preview">{step.caption || '未填写字幕'}</div>
              {step.captionPosition === '角标提示' && <div class="corner-caption">{step.caption.slice(0, 18) || '角标提示'}</div>}
              <div class="safe-area"><span>字幕安全区</span></div>
            </div>
            <div class="player-controls">
              <button class="play-button" onClick={() => this.togglePlay()}>{this.playing ? 'Ⅱ' : '▶'}</button>
              <div class="player-timeline">
                <span style={{ width: `${progress}%` }} />
                {step.cuePoints.map((cue) => <i style={{ left: `${Math.min(100, (cue / Math.max(1, step.duration)) * 100)}%` }} title={`检查点 ${cue}s`} />)}
              </div>
              <span class="time-code">{String(Math.floor(this.playProgress * step.duration)).padStart(2, '0')} / {step.duration}s</span>
            </div>
            <div class="preview-meta">
              <div><strong>{step.kind}</strong><span>步骤类型</span></div>
              <div><strong>{step.difficulty}</strong><span>难度标签</span></div>
              <div><strong>{step.cuePoints.length}</strong><span>检查点</span></div>
            </div>
            {xref && <p class="preview-path-note">🔗 前置来自 {xrefModule?.title}：{xrefTarget?.title ?? '引用挂起中'}</p>}
            <p class="preview-caption-text">{step.caption}</p>
          </div>
        ) : <div class="empty-preview">选择步骤后显示设备预览。</div>}
      </section>
    );
  }

  private renderChecks() {
    const errors = this.checks.filter((check) => check.severity === 'error');
    const warnings = this.checks.filter((check) => check.severity === 'warning');
    const info = this.checks.filter((check) => check.severity === 'info');
    return (
      <section class="checks-panel">
        <div class="checks-summary">
          <div class="check-stat danger"><strong>{errors.length}</strong><span>阻断问题</span></div>
          <div class="check-stat warning"><strong>{warnings.length}</strong><span>需注意（含挂起引用）</span></div>
          <div class="check-stat"><strong>{info.length}</strong><span>优化建议</span></div>
        </div>
        <div class="check-list">
          {this.checks.length === 0 && <div class="all-clear"><strong>✓ 未发现问题</strong><p>字幕遮挡、步骤跳级、跨模块学习路径和替代文本检查均已通过。</p></div>}
          {this.checks.map((check) => (
            <button class={`check-item ${check.severity}`} onClick={() => {
              if (check.moduleId) this.selectModule(check.moduleId);
              if (check.stepId) this.selectStep(check.stepId);
              this.activePanel = 'editor';
            }}>
              <span class="check-severity">{check.severity === 'error' ? '!' : check.severity === 'warning' ? '△' : 'i'}</span>
              <span><strong>{check.title}</strong><small>{check.detail}</small></span>
              <span class="check-arrow">→</span>
            </button>
          ))}
        </div>
      </section>
    );
  }

  private renderTeacherSwitcher() {
    return (
      <div class="teacher-switcher">
        <span class="window-label">当前窗口</span>
        {TEACHERS.map((teacher) => (
          <button
            class={`teacher-chip ${teacher.id === this.teacherId ? 'active' : ''}`}
            style={teacher.id === this.teacherId ? { borderColor: teacher.color, background: `${teacher.color}18` } : undefined}
            onClick={() => this.switchTeacher(teacher.id)}
            title={teacher.scope}
          >
            <span class="teacher-avatar" style={{ background: teacher.color }}>{teacher.initial}</span>
            <span class="teacher-meta"><strong>{teacher.name}</strong><small>{teacher.scope}</small></span>
          </button>
        ))}
      </div>
    );
  }

  private renderModuleCard(item: CourseModule) {
    const owner = teacherById(item.ownerId || 'teacher-guest');
    const isActive = item.id === this.currentModule?.id;
    const suspendedCount = item.steps.filter((step) => referenceForStep(this.project, step.id)?.status === 'suspended').length;
    return (
      <section class={`module-card ${isActive ? 'active' : ''}`} key={item.id}>
        <button class="module-head" onClick={() => this.selectModule(item.id)}>
          <span class="module-color" style={{ background: item.color }} />
          <span>
            <strong>{item.title}</strong>
            <small>
              {item.ownerId ? `归属 ${owner.name}` : '未认领'} · {item.steps.length} 个步骤
              {suspendedCount > 0 && <em class="suspended-flag"> · {suspendedCount} 条引用挂起</em>}
            </small>
          </span>
        </button>
        {isActive && <div class="step-list">{item.steps.map((lesson, index) => this.renderStepListItem(lesson, index))}</div>}
      </section>
    );
  }

  private renderSyncCenter() {
    if (!this.showSyncCenter) return null;
    const suspended = this.project.references.filter((reference) => reference.status === 'suspended');
    return (
      <div class="sync-overlay" onClick={() => { this.showSyncCenter = false; }}>
        <div class="sync-drawer" onClick={(event) => event.stopPropagation()}>
          <div class="sync-drawer-head">
            <div><span class="eyebrow">同步中心</span><h2>双窗口协作与离线补回</h2></div>
            <button class="sync-close" onClick={() => { this.showSyncCenter = false; }}>×</button>
          </div>

          <div class="sync-status-row">
            <div class={`sync-dot ${this.offline ? 'offline' : 'online'}`} />
            <strong>{this.offline ? '离线编辑中' : '在线'}</strong>
            <span>共享文档修订号 {this.shared.project.revision} · 本机 {this.clientId}</span>
            <ion-button size="small" fill="outline" class="studio-button" onClick={() => this.toggleOffline()}>
              {this.offline ? '模拟网络恢复' : '模拟断网'}
            </ion-button>
            <ion-button size="small" class="studio-button" disabled={this.offline || this.outbox.length === 0} onClick={() => this.flushOutbox(true)}>
              立即补回发件箱
            </ion-button>
          </div>

          <h3>断网期间待补回的改动（{this.outbox.length}）</h3>
          {this.outbox.length === 0
            ? <p class="sync-empty">没有待补回的改动。{this.offline ? '断网时照常编辑，改动会按顺序排在这里。' : '所有编辑都已在共享课程中。'}</p>
            : (
              <ol class="outbox-list">
                {this.outbox.map((op) => (
                  <li key={op.id}>
                    <span class="outbox-label">{describeOperation(op)}</span>
                    <small>{this.formatDate(op.at)}</small>
                  </li>
                ))}
              </ol>
            )}
          <p class="sync-hint">网络恢复后会按顺序重放这些改动：内容已与课程一致的自动跳过，不会重复写入；若改动涉及的步骤已被对方老师删除或挪动，对应跨模块引用会自动挂起。</p>

          <h3>挂起待确认的跨模块引用（{suspended.length}）</h3>
          {suspended.length === 0
            ? <p class="sync-empty">没有挂起引用。</p>
            : (
              <div class="suspended-list">
                {suspended.map((reference) => {
                  const ownerModule = this.project.modules.find((module) => module.id === reference.ownerModuleId);
                  const step = ownerModule?.steps.find((item) => item.id === reference.stepId);
                  const target = findStep(this.project, reference.targetModuleId, reference.targetStepId);
                  const targetModule = this.project.modules.find((module) => module.id === reference.targetModuleId);
                  const canResolve = ownerModule?.ownerId === this.teacherId;
                  return (
                    <div class="suspended-item" key={reference.id}>
                      <div>
                        <strong>{step?.title ?? '（步骤已删除）'}</strong>
                        <small>前置「{targetModule?.title ?? '未知模块'} / {target?.title ?? '已不存在'}」 · {reference.suspendReason}</small>
                      </div>
                      {canResolve && (
                        <div class="ref-actions">
                          <ion-button size="small" fill="outline" color="danger" class="studio-button" onClick={() => this.resolveReference(reference.id, 'remove')}>解除</ion-button>
                          <ion-button size="small" class="studio-button" onClick={() => this.resolveReference(reference.id, 'reaffirm')}>确认保留</ion-button>
                        </div>
                      )}
                      {!canResolve && <small class="sync-empty">等待{teacherById(ownerModule?.ownerId || 'teacher-guest').name}确认</small>}
                    </div>
                  );
                })}
              </div>
            )}
        </div>
      </div>
    );
  }

  render() {
    const module = this.currentModule;
    const errors = this.checks.filter((check) => check.severity === 'error').length;
    const suspendedCount = this.project.references.filter((reference) => reference.status === 'suspended').length;
    return (
      <Host>
        <ion-app>
          <ion-header class="studio-header">
            <ion-toolbar>
              <ion-buttons slot="start"><div class="logo-mark">手</div><div class="app-title"><strong>SignCourse Studio</strong><span>手语课程编排工具 · 双窗口协作</span></div></ion-buttons>
              <ion-buttons slot="end" class="header-actions">
                {this.renderTeacherSwitcher()}
                <button class={`connection-status ${this.offline ? 'offline' : ''}`} onClick={() => { this.showSyncCenter = true; }}>
                  <span />{this.offline ? `离线 · 发件箱 ${this.outbox.length}` : '共享已同步'}
                  {(this.outbox.length > 0 || suspendedCount > 0) && <i class="sync-badge">{this.outbox.length + suspendedCount}</i>}
                </button>
                <ion-button fill="clear" class="studio-button" disabled={this.past.length === 0} onClick={() => this.undo()}>撤销</ion-button>
                <ion-button fill="clear" class="studio-button" disabled={this.future.length === 0} onClick={() => this.redo()}>重做</ion-button>
                <ion-button fill="outline" class="studio-button" onClick={() => this.saveDraft()}>保存草稿</ion-button>
                {this.project.status === 'review'
                  ? <ion-button color="success" class="studio-button" onClick={() => this.freezeVersion()}>冻结版本</ion-button>
                  : this.project.status === 'changes'
                    ? <ion-button color="warning" class="studio-button" onClick={() => this.submitForReview()}>重新提交</ion-button>
                    : this.project.status === 'frozen'
                      ? <ion-button class="studio-button" onClick={() => this.reviseFrozen()}>创建修订版</ion-button>
                      : <ion-button color="primary" class="studio-button" onClick={() => this.submitForReview()}>提交复核</ion-button>}
              </ion-buttons>
            </ion-toolbar>
          </ion-header>

          <ion-content fullscreen>
            <div class="project-ribbon">
              <div class="project-heading">
                {this.renderStatusBadge()}
                <ion-input value={this.project.title} disabled={this.project.status === 'frozen'} class="project-title-input" onIonInput={(event) => {
                  const next = { ...this.project, title: event.detail.value ?? '' };
                  this.persistWorking(next);
                }} onIonBlur={(event) => this.updateCourse({ title: (event.target as HTMLIonInputElement).value?.toString() ?? '' })} />
                <span>{this.project.teacher} · {this.project.audience}</span>
              </div>
              <div class="project-metrics">
                <div><strong>{this.project.modules.length}</strong><span>模块</span></div>
                <div><strong>{this.project.modules.reduce((sum, item) => sum + item.steps.length, 0)}</strong><span>步骤</span></div>
                <div><strong>{this.project.references.filter((r) => r.status === 'active').length}</strong><span>跨模块路径</span></div>
                <div class={errors ? 'has-errors' : ''}><strong>{errors}</strong><span>阻断问题</span></div>
              </div>
              <div class="workflow-actions">
                {this.project.status === 'review' && <ion-button fill="clear" color="danger" class="studio-button" onClick={() => this.returnForChanges()}>退回修改</ion-button>}
                {this.project.status === 'draft' && <ion-button fill="clear" class="studio-button" onClick={() => this.addModule()}>＋ 新建模块</ion-button>}
                <ion-button fill="clear" class="studio-button" onClick={() => this.addStep('练习')}>＋ 练习步骤</ion-button>
                <ion-button fill="clear" class="studio-button" onClick={() => { this.showSyncCenter = true; }}>同步中心</ion-button>
              </div>
            </div>

            <main class="studio-workspace">
              <aside class="course-panel">
                <div class="panel-heading"><div><span class="eyebrow">课程结构</span><h2>模块与步骤</h2></div><button class="add-step-button" onClick={() => this.addStep('示范')}>＋</button></div>
                <div class="module-list">
                  {this.project.modules.map((item) => this.renderModuleCard(item))}
                </div>
                <div class="module-editor">
                  <div class="module-owner-row">
                    <span class="owner-pill" style={{ background: teacherById(module?.ownerId || 'teacher-guest').color }}>
                      {module?.ownerId ? `${teacherById(module.ownerId).name}负责` : '未认领'}
                    </span>
                    {module && !module.ownerId && this.teacherId !== 'teacher-guest' && this.project.status !== 'frozen' && (
                      <ion-button size="small" fill="outline" class="studio-button" onClick={() => this.claimModule(module.id)}>认领</ion-button>
                    )}
                  </div>
                  <ion-input disabled={!this.canEditModule(module)} label="当前模块标题" labelPlacement="stacked" class="studio-input" value={module?.title ?? ''} onIonInput={(event) => this.updateCurrentModule({ title: event.detail.value ?? '' })} />
                  <ion-textarea disabled={!this.canEditModule(module)} autoGrow label="模块目标" labelPlacement="stacked" class="studio-input" value={module?.summary ?? ''} onIonInput={(event) => this.updateCurrentModule({ summary: event.detail.value ?? '' })} />
                </div>
              </aside>

              <section class="editor-panel">
                <div class="panel-switcher">
                  <button class={this.activePanel === 'editor' ? 'active' : ''} onClick={() => { this.activePanel = 'editor'; }}>步骤编排</button>
                  <button class={this.activePanel === 'checks' ? 'active' : ''} onClick={() => { this.activePanel = 'checks'; }}>
                    发布前检查 <span>{this.checks.length}</span>
                    {suspendedCount > 0 && <em class="switcher-suspended">·{suspendedCount} 引用挂起</em>}
                  </button>
                </div>
                <div class="editor-scroll">{this.activePanel === 'editor' ? this.renderStepEditor() : this.renderChecks()}</div>
              </section>

              {this.renderPreview()}
            </main>
          </ion-content>
          {this.renderSyncCenter()}
          <ion-toast isOpen={Boolean(this.toast)} message={this.toast?.message} color={this.toast?.color} duration={3600} onDidDismiss={() => { this.toast = undefined; }} />
        </ion-app>
      </Host>
    );
  }
}

// —— 引用核对的本地内联实现（与 models.reconcileReferences 规则一致，供拉取共享后使用） ——

function payloadHints(payload: OperationPayload): { deletedStepIds?: string[]; movedStepIds?: string[] } {
  if (payload.type === 'deleteStep') return { deletedStepIds: [payload.stepId] };
  if (payload.type === 'moveStep') return { movedStepIds: [payload.stepId] };
  if (payload.type === 'removeModule') return { deletedStepIds: [] };
  return {};
}

function reconcileForPull(project: CourseProject): CourseProject {
  return reconcileRefsInline(project, { deletedStepIds: [], movedStepIds: [] }, true);
}

function reconcileRefsInline(
  project: CourseProject,
  hints: { deletedStepIds?: string[]; movedStepIds?: string[] },
  rescanAll = false,
): CourseProject {
  const deleted = new Set(hints.deletedStepIds ?? []);
  const moved = new Set(hints.movedStepIds ?? []);
  const stamp = new Date().toISOString();
  let changed = false;

  const references = project.references.map((reference) => {
    if (reference.status === 'suspended') return reference;
    const ownerModule = project.modules.find((module) => module.id === reference.ownerModuleId);
    const ownerExists = ownerModule?.steps.some((step) => step.id === reference.stepId);
    if (!ownerExists) {
      changed = true;
      return undefined;
    }
    const targetModule = project.modules.find((module) => module.id === reference.targetModuleId);
    const target = targetModule?.steps.find((step) => step.id === reference.targetStepId);
    let reason = '';
    if (deleted.has(reference.targetStepId) || !target) {
      reason = '被引用的前置步骤已被对方老师删除';
    } else if (moved.has(reference.targetStepId)) {
      reason = '被引用的前置步骤被对方老师挪动了位置';
    } else if (rescanAll && stepOrderKey(project, reference.targetModuleId, reference.targetStepId)
      >= stepOrderKey(project, reference.ownerModuleId, reference.stepId)) {
      reason = '被引用步骤目前位于本步骤之后，学习顺序不成立';
    }
    if (!reason) return reference;
    changed = true;
    return { ...reference, status: 'suspended' as const, suspendReason: reason, updatedAt: stamp };
  }).filter(Boolean) as StepReference[];

  return changed ? { ...project, references } : project;
}
