import { Component, Host, State, h, Listen } from '@stencil/core';
import { alertController } from '@ionic/core';
import {
  cloneProject,
  createDemoProject,
  selectedModule,
  selectedStep,
  STORAGE_KEY,
  validateProject,
  type CameraAngle,
  type CaptionPosition,
  type CourseModule,
  type CourseProject,
  type Difficulty,
  type GestureZone,
  type LessonStep,
  type StepRef,
  type TeacherId,
  type ValidationCheck,
} from '../../models';
import {
  broadcast,
  emptySharedDoc,
  loadSharedDoc,
  loadWindowState,
  mergeForWindow,
  migrateProject,
  saveSharedDoc,
  saveWindowState,
  subscribeShared,
  TEACHERS,
  teacherFromLocation,
  type ScalarField,
  type SharedDoc,
  type WindowState,
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
  @State() toast?: { color: string; message: string };
  @State() teacherId: TeacherId = 'teacher-1';
  @State() syncState: 'synced' | 'pending' | 'offline' = 'synced';
  @State() pendingCount = 0;
  private past: CourseProject[] = [];
  private future: CourseProject[] = [];
  private playTimer?: number;
  private pendingModules: string[] = [];
  private pendingScalars: ScalarField[] = [];
  private scalarUpdatedAt: Partial<Record<ScalarField, string>> = {};
  private unsubscribeShared?: () => void;

  componentWillLoad(): void {
    this.teacherId = teacherFromLocation();
    const saved = loadWindowState(this.teacherId);
    if (saved) {
      this.project = saved.project;
      this.pendingModules = saved.pendingModules;
      this.pendingScalars = saved.pendingScalars;
      this.scalarUpdatedAt = saved.scalarUpdatedAt;
    } else {
      const legacyRaw = localStorage.getItem(STORAGE_KEY);
      if (legacyRaw) {
        try {
          this.project = migrateProject(JSON.parse(legacyRaw));
          this.showToast('success', '已迁移到协同编辑模式：模块归属与跨模块引用已就绪。');
        } catch {
          this.project = createDemoProject();
        }
      } else {
        this.project = createDemoProject();
      }
    }
    this.ensureSharedDoc();
    this.refreshSyncState();
    this.unsubscribeShared = subscribeShared(() => this.handleRemoteUpdate());
  }

  disconnectedCallback(): void {
    if (this.playTimer) window.clearInterval(this.playTimer);
    this.unsubscribeShared?.();
  }

  /** 首次使用时建立共享课程文档；若另一窗口已建立，则拉取最新版本。 */
  private ensureSharedDoc(): void {
    if (this.offline) return;
    const shared = loadSharedDoc();
    if (!shared) {
      const doc = emptySharedDoc(this.project);
      saveSharedDoc(doc);
      broadcast(doc);
      return;
    }
    const merged = mergeForWindow(this.project, shared, this.teacherId, this.pendingModules, this.scalarUpdatedAt);
    this.project = merged.project;
    this.scalarUpdatedAt = merged.scalarUpdatedAt;
    this.persistWindow();
    if (this.pendingModules.length + this.pendingScalars.length > 0) this.syncNow('flush');
  }

  /** 另一窗口保存后，把共享课程中属于对方老师的改动合并进来。 */
  private handleRemoteUpdate(): void {
    if (this.offline) return;
    const shared = loadSharedDoc();
    if (!shared) return;
    const merged = mergeForWindow(this.project, shared, this.teacherId, this.pendingModules, this.scalarUpdatedAt);
    this.project = merged.project;
    this.scalarUpdatedAt = merged.scalarUpdatedAt;
    this.persistWindow();
    this.refreshSyncState();
    this.showToast('success', '另一窗口的课程改动已同步。');
  }

  /** 把本窗口的改动合并进共享课程；断网期间则作为待补回改动排队。 */
  private syncNow(reason: 'edit' | 'online' | 'flush'): void {
    if (this.offline) return;
    const shared = loadSharedDoc();
    const pendingModuleCount = new Set(this.pendingModules).size;
    const pendingScalarCount = new Set(this.pendingScalars).size;
    const merged = mergeForWindow(this.project, shared, this.teacherId, this.pendingModules, this.scalarUpdatedAt);
    const doc: SharedDoc = { project: merged.project, updatedAt: new Date().toISOString(), scalarUpdatedAt: merged.scalarUpdatedAt };
    const changed = !shared
      || JSON.stringify(shared.project) !== JSON.stringify(doc.project)
      || JSON.stringify(shared.scalarUpdatedAt) !== JSON.stringify(doc.scalarUpdatedAt);
    if (changed) {
      saveSharedDoc(doc);
      broadcast(doc);
    }
    this.project = merged.project;
    this.scalarUpdatedAt = merged.scalarUpdatedAt;
    this.pendingModules = [];
    this.pendingScalars = [];
    this.persistWindow();
    this.refreshSyncState();
    if (reason === 'online') {
      this.showToast('success', `断网期间的改动已补回课程：${pendingModuleCount} 个模块、${pendingScalarCount} 项设置已同步；${merged.noopModuleIds.length} 项与课程现状一致，未重复写入。`);
    }
  }

  /** 本地提交后，记录受影响的模块/标量；在线立即同步，离线排队等恢复。 */
  private afterLocalChange(before: CourseProject, next: CourseProject): void {
    const beforeMap = new Map(before.modules.map((module) => [module.id, module]));
    for (const module of next.modules) {
      const beforeModule = beforeMap.get(module.id);
      if (!beforeModule || JSON.stringify(beforeModule) !== JSON.stringify(module)) {
        if (!this.pendingModules.includes(module.id)) this.pendingModules.push(module.id);
      }
    }
    for (const module of before.modules) {
      if (!next.modules.some((candidate) => candidate.id === module.id) && !this.pendingModules.includes(module.id)) {
        this.pendingModules.push(module.id);
      }
    }
    const now = new Date().toISOString();
    for (const field of ['title', 'teacher', 'audience', 'status', 'revision', 'lastSavedAt'] as ScalarField[]) {
      if (JSON.stringify(before[field]) !== JSON.stringify(next[field])) {
        if (!this.pendingScalars.includes(field)) this.pendingScalars.push(field);
        this.scalarUpdatedAt[field] = now;
      }
    }
    if (this.offline) {
      this.refreshSyncState();
    } else {
      this.syncNow('edit');
    }
  }

  private refreshSyncState(): void {
    this.pendingCount = this.pendingModules.length + this.pendingScalars.length;
    if (this.offline) this.syncState = 'offline';
    else if (this.pendingCount > 0) this.syncState = 'pending';
    else this.syncState = 'synced';
  }

  private persistWindow(): void {
    const state: WindowState = {
      project: this.project,
      pendingModules: this.pendingModules,
      pendingScalars: this.pendingScalars,
      scalarUpdatedAt: this.scalarUpdatedAt,
    };
    saveWindowState(this.teacherId, state);
  }

  @Listen('online', { target: 'window' })
  handleOnline(): void {
    this.offline = false;
    this.syncNow('online');
  }

  @Listen('offline', { target: 'window' })
  handleOffline(): void {
    this.offline = true;
    this.refreshSyncState();
    this.showToast('warning', '当前处于离线状态，修改会继续保存在本机，恢复网络后自动补回课程。');
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
    return validateProject(this.project);
  }

  private persist(): void {
    this.persistWindow();
  }

  /** 当前窗口身份是否负责该模块（模块归属老师才能编辑）。 */
  private get canEditCurrentModule(): boolean {
    return this.currentModule?.ownerId === this.teacherId;
  }

  private commit(update: (draft: CourseProject) => CourseProject, toast?: string): void {
    if (this.project.status === 'frozen') {
      this.showToast('warning', '当前版本已冻结，请先创建修订版。');
      return;
    }
    const before = cloneProject(this.project);
    const next = update(cloneProject(this.project));
    next.revision = before.revision + 1;
    next.lastSavedAt = new Date().toISOString();
    this.past = [...this.past, before].slice(-80);
    this.future = [];
    this.project = next;
    this.persist();
    this.afterLocalChange(before, next);
    if (toast) this.showToast('success', toast);
  }

  private undo(): void {
    const previous = this.past.pop();
    if (!previous) return this.showToast('medium', '没有可撤销的修改。');
    const before = cloneProject(this.project);
    this.future = [cloneProject(this.project), ...this.future].slice(0, 80);
    this.project = previous;
    this.persist();
    this.afterLocalChange(before, previous);
  }

  private redo(): void {
    const next = this.future.shift();
    if (!next) return;
    const before = cloneProject(this.project);
    this.past = [...this.past, cloneProject(this.project)].slice(-80);
    this.project = next;
    this.persist();
    this.afterLocalChange(before, next);
  }

  private showToast(color: string, message: string): void {
    this.toast = { color, message };
    window.setTimeout(() => {
      if (this.toast?.message === message) this.toast = undefined;
    }, 3_200);
  }

  private updateTitle(value: string): void {
    if (this.project.status === 'frozen') return;
    this.commit((draft) => ({ ...draft, title: value }));
  }

  private selectModule(moduleId: string): void {
    const module = this.project.modules.find((item) => item.id === moduleId);
    this.project = { ...this.project, selectedModuleId: moduleId, selectedStepId: module?.steps[0]?.id ?? '' };
    this.persist();
  }

  private selectStep(stepId: string): void {
    this.project = { ...this.project, selectedStepId: stepId };
    this.persist();
  }

  private updateStep(patch: Partial<LessonStep>, toast?: string): void {
    const stepId = this.currentStep?.id;
    if (!stepId) return;
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? {
        ...module,
        steps: module.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step),
      } : module),
    }), toast);
  }

  private updateCurrentModule(patch: Partial<CourseModule>): void {
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? { ...module, ...patch } : module),
    }));
  }

  private addModule(): void {
    const index = this.project.modules.length + 1;
    const module: CourseModule = {
      id: `module-${Date.now().toString(36)}`,
      title: `模块 ${index} · 未命名`,
      summary: '说明该模块的学习目标与适用场景。',
      color: ['#15827a', '#8a3ffc', '#b34331', '#376ea8'][index % 4],
      ownerId: this.teacherId,
      steps: [],
    };
    this.commit((draft) => ({ ...draft, modules: [...draft.modules, module], selectedModuleId: module.id, selectedStepId: '' }), '已创建课程模块。');
  }

  private addStep(kind: LessonStep['kind'] = '示范'): void {
    const module = this.currentModule;
    if (!module) return this.addModule();
    if (module.ownerId !== this.teacherId) {
      this.showToast('warning', '该模块由对方老师负责编辑，你可以查看并引用其中的步骤。');
      return;
    }
    const prior = module.steps.at(-1);
    const step: LessonStep = {
      id: `step-${this.teacherId}-${Date.now().toString(36)}`,
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
      prerequisite: prior ? { moduleId: module.id, stepId: prior.id, status: 'active' } : null,
      difficulty: '入门',
      cuePoints: [8, 20, 32],
    };
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((item) => item.id === module.id ? { ...item, steps: [...item.steps, step] } : item),
      selectedStepId: step.id,
    }), '已新增学习步骤。');
  }

  private duplicateStep(): void {
    const step = this.currentStep;
    if (!step) return;
    if (!this.canEditCurrentModule) {
      this.showToast('warning', '该模块由对方老师负责编辑。');
      return;
    }
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => {
        if (module.id !== draft.selectedModuleId) return module;
        const index = module.steps.findIndex((item) => item.id === step.id);
        const duplicate = { ...structuredClone(step), id: `step-${this.teacherId}-${Date.now().toString(36)}`, title: `${step.title}（副本）` };
        return { ...module, steps: [...module.steps.slice(0, index + 1), duplicate, ...module.steps.slice(index + 1)] };
      }),
    }), '已复制当前步骤。');
  }

  private deleteStep(stepId: string): void {
    if (!this.canEditCurrentModule) {
      this.showToast('warning', '该模块由对方老师负责编辑。');
      return;
    }
    if (this.currentModule.steps.length <= 1) {
      this.showToast('warning', '模块至少保留一个学习步骤。');
      return;
    }
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => module.id === draft.selectedModuleId ? {
        ...module,
        steps: module.steps.filter((step) => step.id !== stepId),
      } : module),
      selectedStepId: this.currentModule.steps.find((step) => step.id !== stepId)?.id ?? '',
    }), '已删除学习步骤，引用该步骤的老师会看到引用挂起。');
  }

  private moveStep(direction: number): void {
    const stepId = this.currentStep?.id;
    if (!stepId) return;
    if (!this.canEditCurrentModule) {
      this.showToast('warning', '该模块由对方老师负责编辑。');
      return;
    }
    this.commit((draft) => ({
      ...draft,
      modules: draft.modules.map((module) => {
        if (module.id !== draft.selectedModuleId) return module;
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

  /** 把步骤移动到其他模块；跨模块引用仍然有效，引用方会收到挂起确认。 */
  private async moveStepToModule(): Promise<void> {
    const step = this.currentStep;
    const fromModule = this.currentModule;
    if (!step || !fromModule) return;
    if (!this.canEditCurrentModule) {
      this.showToast('warning', '该模块由对方老师负责编辑。');
      return;
    }
    const targets = this.project.modules.filter((module) => module.id !== fromModule.id && module.ownerId === this.teacherId);
    if (!targets.length) {
      this.showToast('medium', '你负责的模块中还没有其他模块可以移动过去（步骤只能在自己负责的模块间移动）。');
      return;
    }
    const alert = await alertController.create({
      header: '移动到其他模块',
      message: `将「${step.title}」移动到：`,
      inputs: targets.map((module) => ({ type: 'radio', label: module.title, value: module.id })),
      buttons: [
        { text: '取消', role: 'cancel' },
        {
          text: '移动',
          handler: (targetModuleId: string) => {
            if (targetModuleId) this.commitMove(step.id, targetModuleId);
          },
        },
      ],
    });
    await alert.present();
  }

  private commitMove(stepId: string, targetModuleId: string): void {
    this.commit((draft) => {
      const from = draft.modules.find((module) => module.id === draft.selectedModuleId);
      const moving = from?.steps.find((step) => step.id === stepId);
      const target = draft.modules.find((module) => module.id === targetModuleId);
      if (!from || !moving || !target || from.id === target.id) return draft;
      return {
        ...draft,
        modules: draft.modules.map((module) => {
          if (module.id === from.id) return { ...module, steps: module.steps.filter((step) => step.id !== stepId) };
          if (module.id === target.id) return { ...module, steps: [...module.steps, moving] };
          return module;
        }),
        selectedModuleId: target.id,
        selectedStepId: stepId,
      };
    }, '步骤已移动到其他模块，引用该步骤的老师会看到挂起确认。');
  }

  /** 引用挂起（目标被移动）：确认跟随到新模块。 */
  private confirmMovedPrerequisite(): void {
    const step = this.currentStep;
    const ref = step?.prerequisite;
    if (!step || !ref?.movedToModuleId) return;
    const prerequisite: StepRef = { moduleId: ref.movedToModuleId, stepId: ref.stepId, status: 'active' };
    this.updateStep({ prerequisite }, '已确认前置步骤的新位置，引用恢复正常。');
  }

  /** 引用挂起（目标被删除或放弃跟随）：解除引用。 */
  private clearPrerequisite(): void {
    this.updateStep({ prerequisite: null }, '已解除挂起的前置引用。');
  }

  private saveDraft(showMessage = true): void {
    if (this.project.status === 'frozen') {
      this.showToast('warning', '冻结版本不可覆盖，请先创建修订版。');
      return;
    }
    const before = cloneProject(this.project);
    const next = { ...this.project, status: 'draft' as const, lastSavedAt: new Date().toISOString() };
    this.project = next;
    this.persist();
    this.afterLocalChange(before, next);
    if (showMessage) this.showToast('success', '草稿已保存在浏览器本地。');
  }

  private submitForReview(): void {
    const blocking = this.checks.filter((check) => check.severity === 'error');
    if (blocking.length) {
      this.activePanel = 'checks';
      this.showToast('danger', `仍有 ${blocking.length} 个阻断问题，修复后才能提交复核。`);
      return;
    }
    this.commit((draft) => ({ ...draft, status: 'review' }), '课程已提交复核。');
  }

  private returnForChanges(): void {
    this.commit((draft) => ({ ...draft, status: 'changes' }), '课程已退回修改。');
  }

  private freezeVersion(): void {
    const blocking = this.checks.filter((check) => check.severity === 'error');
    if (blocking.length) {
      this.activePanel = 'checks';
      this.showToast('danger', `冻结前仍有 ${blocking.length} 个阻断问题。`);
      return;
    }
    this.commit((draft) => {
      const { frozenVersions, ...snapshot } = cloneProject(draft);
      const version = {
        id: `frozen-${Date.now().toString(36)}`,
        label: `冻结版本 v${frozenVersions.length + 1}`,
        createdAt: new Date().toISOString(),
        snapshot,
      };
      return { ...draft, status: 'frozen', frozenVersions: [version, ...frozenVersions] };
    }, '当前课程版本已冻结。');
    this.playing = false;
  }

  private reviseFrozen(): void {
    this.commit((draft) => ({ ...draft, status: 'draft' }), '已创建修订版，可继续编辑。');
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
    if (this.project.status === 'changes') return <ion-badge color="danger">已退回</ion-badge>;
    if (this.project.status === 'frozen') return <ion-badge color="success">已冻结</ion-badge>;
    return <ion-badge color="medium">草稿</ion-badge>;
  }

  private renderStepListItem(step: LessonStep, index: number) {
    const active = step.id === this.currentStep?.id;
    const issueCount = this.checks.filter((check) => check.stepId === step.id && check.severity !== 'info').length;
    return (
      <button class={`step-list-item ${active ? 'active' : ''}`} onClick={() => this.selectStep(step.id)}>
        <span class="step-index">{String(index + 1).padStart(2, '0')}</span>
        <span class="step-copy">
          <strong>{step.title}</strong>
          <small>{step.kind} · {step.duration}s · {step.difficulty}</small>
        </span>
        {issueCount > 0 && <span class="step-issue-count">{issueCount}</span>}
      </button>
    );
  }

  private renderStepEditor() {
    const step = this.currentStep;
    if (!step) {
      return (
        <div class="empty-editor">
          <div class="empty-glyph">手</div>
          <h2>这个模块还没有学习步骤</h2>
          <p>添加示范、讲解或练习步骤，然后设置跨模块前置条件与难度。</p>
          <ion-button class="studio-button" disabled={!this.canEditCurrentModule} onClick={() => this.addStep('示范')}>添加第一个步骤</ion-button>
        </div>
      );
    }
    const frozen = this.project.status === 'frozen' || !this.canEditCurrentModule;
    const module = this.currentModule;
    const ref = step.prerequisite;
    const refTarget = ref
      ? this.project.modules
        .find((candidateModule) => candidateModule.id === (ref.status === 'suspended' && ref.reason === 'moved' && ref.movedToModuleId ? ref.movedToModuleId : ref.moduleId))
        ?.steps.find((candidateStep) => candidateStep.id === ref.stepId)
      : undefined;
    const refTargetModule = ref
      ? this.project.modules.find((candidateModule) => candidateModule.id === (ref.status === 'suspended' && ref.reason === 'moved' && ref.movedToModuleId ? ref.movedToModuleId : ref.moduleId))
      : undefined;
    return (
      <div class="step-editor">
        <div class="editor-title-row">
          <div>
            <span class="eyebrow">学习步骤 {module.steps.findIndex((item) => item.id === step.id) + 1}</span>
            <h1>{step.title}</h1>
            <p>最后修改 {this.formatDate(this.project.lastSavedAt)} · 修订号 {this.project.revision}</p>
          </div>
          <div class="title-actions">
            <ion-button fill="clear" class="studio-button" disabled={frozen} onClick={() => this.moveStep(-1)} title="Alt + ↑">上移</ion-button>
            <ion-button fill="clear" class="studio-button" disabled={frozen} onClick={() => this.moveStep(1)} title="Alt + ↓">下移</ion-button>
            <ion-button fill="outline" class="studio-button" disabled={frozen} onClick={() => this.moveStepToModule()}>移到模块</ion-button>
            <ion-button fill="outline" class="studio-button" disabled={frozen} onClick={() => this.duplicateStep()}>复制</ion-button>
            <ion-button fill="outline" color="danger" class="studio-button" disabled={frozen} onClick={() => this.deleteStep(step.id)}>删除</ion-button>
          </div>
        </div>

        {!this.canEditCurrentModule && (
          <div class="owner-callout">
            <div><strong>你正在查看{TEACHERS[module.ownerId ?? 'teacher-1'].name}负责的模块</strong><span>模块内容只读；如需调整，请切换到负责老师的窗口。</span></div>
          </div>
        )}

        {frozen && this.project.status === 'frozen' && (
          <div class="frozen-callout">
            <div><strong>此版本已冻结</strong><span>字段已锁定，仍可预览和运行检查。</span></div>
            <ion-button size="small" class="studio-button" onClick={() => this.reviseFrozen()}>创建修订版</ion-button>
          </div>
        )}

        {ref?.status === 'suspended' && (
          <div class="ref-callout">
            <span class="ref-callout-icon">!</span>
            <div class="ref-callout-body">
              <strong>跨模块前置引用已挂起</strong>
              <small>
                {ref.reason === 'moved'
                  ? `目标步骤已被移动到「${refTargetModule?.title ?? '其他模块'}」，请确认是否跟随到新位置；确认前该引用不参与学习路径校验。`
                  : '目标步骤已被删除或移出课程，请重新选择前置步骤，或解除这个挂起的引用。'}
              </small>
              <div class="ref-callout-actions">
                {ref.reason === 'moved' && <ion-button size="small" color="warning" class="studio-button" onClick={() => this.confirmMovedPrerequisite()}>确认跟随到新模块</ion-button>}
                <ion-button size="small" fill="outline" class="studio-button" onClick={() => this.clearPrerequisite()}>解除引用</ion-button>
              </div>
            </div>
          </div>
        )}

        <section class="form-card">
          <div class="section-title"><span>01</span><div><h2>基础设计</h2><p>标题、类型、难度和预计时长</p></div></div>
          <div class="form-grid two">
            <ion-input disabled={frozen} label="步骤标题" labelPlacement="stacked" class="studio-input" value={step.title} onIonInput={(event) => this.updateStep({ title: event.detail.value ?? '' })} />
            <ion-select disabled={frozen} label="步骤类型" labelPlacement="stacked" class="studio-input" value={step.kind} onIonChange={(event) => this.updateStep({ kind: event.detail.value as LessonStep['kind'] })}>
              <ion-select-option value="示范">示范</ion-select-option>
              <ion-select-option value="讲解">讲解</ion-select-option>
              <ion-select-option value="练习">练习</ion-select-option>
            </ion-select>
            <ion-select disabled={frozen} label="难度标签" labelPlacement="stacked" class="studio-input" value={step.difficulty} onIonChange={(event) => this.updateStep({ difficulty: event.detail.value as Difficulty })}>
              {(['入门', '进阶', '挑战'] as Difficulty[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} type="number" min="10" max="600" label="预计时长（秒）" labelPlacement="stacked" class="studio-input" value={String(step.duration)} onIonInput={(event) => this.updateStep({ duration: Number(event.detail.value) || 0 })} />
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
              <ion-input disabled={frozen} label="示范片段名称" labelPlacement="stacked" class="studio-input" value={step.demoTitle} onIonInput={(event) => this.updateStep({ demoTitle: event.detail.value ?? '' })} />
              <ion-input disabled={frozen} label="本地素材地址（可空）" labelPlacement="stacked" class="studio-input" value={step.demoUrl} placeholder="例如 assets/hello.mp4" onIonInput={(event) => this.updateStep({ demoUrl: event.detail.value ?? '' })} />
            </div>
          </div>
          <div class="form-grid two">
            <ion-select disabled={frozen} label="镜头角度" labelPlacement="stacked" class="studio-input" value={step.camera} onIonChange={(event) => this.updateStep({ camera: event.detail.value as CameraAngle })}>
              {(['正面', '左侧 45°', '右侧 45°', '俯拍手部', '全身远景'] as CameraAngle[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-select disabled={frozen} label="主要手形区域" labelPlacement="stacked" class="studio-input" value={step.gestureZone} onIonChange={(event) => this.updateStep({ gestureZone: event.detail.value as GestureZone })}>
              {(['左侧', '中央', '右侧'] as GestureZone[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
          </div>
          <ion-textarea disabled={frozen} autoGrow label="手形说明" labelPlacement="stacked" class="studio-input" value={step.handshape} onIonInput={(event) => this.updateStep({ handshape: event.detail.value ?? '' })} />
        </section>

        <section class="form-card">
          <div class="section-title"><span>03</span><div><h2>字幕与无障碍</h2><p>检查字幕位置、动作遮挡与替代文本</p></div></div>
          <div class="form-grid two">
            <ion-select disabled={frozen} label="字幕位置" labelPlacement="stacked" class="studio-input" value={step.captionPosition} onIonChange={(event) => this.updateStep({ captionPosition: event.detail.value as CaptionPosition })}>
              {(['下方安全区', '上移 15%', '角标提示', '画面中央'] as CaptionPosition[]).map((item) => <ion-select-option value={item}>{item}</ion-select-option>)}
            </ion-select>
            <ion-input disabled={frozen} label="替代文本状态" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText ? '已填写' : '缺失'} readonly />
          </div>
          <ion-textarea disabled={frozen} autoGrow label="步骤字幕" labelPlacement="stacked" class="studio-input" value={step.caption} onIonInput={(event) => this.updateStep({ caption: event.detail.value ?? '' })} />
          <ion-textarea disabled={frozen} autoGrow label="替代文本（必须描述动作与表情）" labelPlacement="stacked" class={`studio-input ${step.altText ? '' : 'ion-invalid'}`} value={step.altText} onIonInput={(event) => this.updateStep({ altText: event.detail.value ?? '' })} />
        </section>

        <section class="form-card">
          <div class="section-title"><span>04</span><div><h2>学习依赖与练习</h2><p>前置步骤、常见错误、练习任务与反馈</p></div></div>
          <div class="form-grid two">
            <ion-select
              disabled={frozen}
              label="前置条件（可跨模块）"
              labelPlacement="stacked"
              class="studio-input"
              value={step.prerequisite ? `${step.prerequisite.moduleId}__${step.prerequisite.stepId}` : ''}
              onIonChange={(event) => {
                const value = (event.detail.value ?? '') as string;
                if (!value) {
                  this.updateStep({ prerequisite: null });
                } else {
                  const [moduleId, stepId] = value.split('__');
                  this.updateStep({ prerequisite: { moduleId, stepId, status: 'active' } });
                }
              }}>
              <ion-select-option value="">无前置条件</ion-select-option>
              {this.project.modules.map((candidateModule) =>
                candidateModule.steps
                  .filter((candidateStep) => candidateStep.id !== step.id)
                  .map((candidateStep) => (
                    <ion-select-option key={`${candidateModule.id}__${candidateStep.id}`} value={`${candidateModule.id}__${candidateStep.id}`}>
                      {candidateModule.title} · {candidateStep.title}
                    </ion-select-option>
                  )),
              )}
            </ion-select>
            <ion-input disabled={frozen} label="检查点（秒，用逗号分隔）" labelPlacement="stacked" class="studio-input" value={step.cuePoints.join(', ')} onIonInput={(event) => this.updateStep({ cuePoints: (event.detail.value ?? '').split(/[,，\s]+/).map(Number).filter((value) => Number.isFinite(value)) })} />
          </div>
          {refTarget && refTargetModule && (
            <p class="ref-hint">
              前置步骤：{refTargetModule.title} · {refTarget.title}
              {ref?.status === 'suspended' ? '（引用挂起，等待确认）' : '（跨模块学习路径）'}
            </p>
          )}
          <ion-textarea disabled={frozen} autoGrow label="常见错误（每行一条）" labelPlacement="stacked" class="studio-input" value={step.commonMistakes.join('\n')} onIonInput={(event) => this.updateStep({ commonMistakes: (event.detail.value ?? '').split('\n').filter(Boolean) })} />
          <div class="form-grid two">
            <ion-textarea disabled={frozen} autoGrow label="练习任务" labelPlacement="stacked" class="studio-input" value={step.exercise} onIonInput={(event) => this.updateStep({ exercise: event.detail.value ?? '' })} />
            <ion-textarea disabled={frozen} autoGrow label="练习反馈" labelPlacement="stacked" class="studio-input" value={step.exerciseFeedback} onIonInput={(event) => this.updateStep({ exerciseFeedback: event.detail.value ?? '' })} />
          </div>
        </section>
      </div>
    );
  }

  private renderPreview() {
    const step = this.currentStep;
    const progress = Math.round(this.playProgress * 100);
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
          <div class="check-stat warning"><strong>{warnings.length}</strong><span>需注意</span></div>
          <div class="check-stat"><strong>{info.length}</strong><span>优化建议</span></div>
        </div>
        <div class="check-list">
          {this.checks.length === 0 && <div class="all-clear"><strong>✓ 未发现问题</strong><p>字幕遮挡、步骤跳级和替代文本检查均已通过。</p></div>}
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

  render() {
    const module = this.currentModule;
    const errors = this.checks.filter((check) => check.severity === 'error').length;
    return (
      <Host>
        <ion-app>
          <ion-header class="studio-header">
            <ion-toolbar>
              <ion-buttons slot="start"><div class="logo-mark">手</div><div class="app-title"><strong>SignCourse Studio</strong><span>手语课程编排工具</span></div></ion-buttons>
              <ion-buttons slot="end" class="header-actions">
                <div class="teacher-chip" title="当前窗口身份">
                  <span class="teacher-avatar" style={{ background: TEACHERS[this.teacherId].color }}>{TEACHERS[this.teacherId].short}</span>
                  <div><strong>{TEACHERS[this.teacherId].name}</strong><small>{TEACHERS[this.teacherId].moduleName} · 归属编辑</small></div>
                </div>
                <ion-button fill="clear" class="studio-button open-window-button" onClick={() => window.open(`?teacher=${this.teacherId === 'teacher-1' ? '2' : 'teacher-1'}`, '_blank')}>打开另一窗口</ion-button>
                <button class={`collab-chip ${this.syncState}`} onClick={() => {
                  this.offline = !this.offline;
                  if (this.offline) {
                    this.refreshSyncState();
                    this.showToast('warning', '已进入离线模拟，编辑继续保存在本机，恢复网络后自动补回课程。');
                  } else {
                    this.syncNow('online');
                  }
                }}>
                  <span />
                  {this.syncState === 'synced' && '已协同同步'}
                  {this.syncState === 'pending' && `待同步 · ${this.pendingCount} 项`}
                  {this.syncState === 'offline' && (this.pendingCount ? `离线 · ${this.pendingCount} 项待补回` : '离线编辑中')}
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
                <ion-input value={this.project.title} class="project-title-input" onIonInput={(event) => this.updateTitle(event.detail.value ?? '')} />
                <span>{this.project.teacher} · {this.project.audience}</span>
              </div>
              <div class="project-metrics">
                <div><strong>{this.project.modules.length}</strong><span>模块</span></div>
                <div><strong>{this.project.modules.reduce((sum, item) => sum + item.steps.length, 0)}</strong><span>步骤</span></div>
                <div><strong>{Math.ceil(this.project.modules.reduce((sum, item) => sum + item.steps.reduce((total, lesson) => total + lesson.duration, 0), 0) / 60)}</strong><span>分钟</span></div>
                <div class={errors ? 'has-errors' : ''}><strong>{errors}</strong><span>阻断问题</span></div>
              </div>
              <div class="workflow-actions">
                {this.project.status === 'review' && <ion-button fill="clear" color="danger" class="studio-button" onClick={() => this.returnForChanges()}>退回修改</ion-button>}
                {this.project.status === 'draft' && <ion-button fill="clear" class="studio-button" onClick={() => this.addModule()}>＋ 新建模块</ion-button>}
                <ion-button fill="clear" class="studio-button" onClick={() => this.addStep('练习')}>＋ 练习步骤</ion-button>
              </div>
            </div>

            <main class="studio-workspace">
              <aside class="course-panel">
                <div class="panel-heading"><div><span class="eyebrow">课程结构</span><h2>模块与步骤</h2></div><button class="add-step-button" disabled={!this.canEditCurrentModule} onClick={() => this.addStep('示范')}>＋</button></div>
                <div class="module-list">
                  {this.project.modules.map((item) => (
                    <section class={`module-card ${item.id === module?.id ? 'active' : ''}`} key={item.id}>
                      <button class="module-head" onClick={() => this.selectModule(item.id)}>
                        <span class="module-color" style={{ background: item.color }} />
                        <span><strong>{item.title}</strong><small>{item.steps.length} 个学习步骤</small></span>
                        <span class={`owner-chip owner-${item.ownerId ?? 'teacher-1'}`}>{TEACHERS[item.ownerId ?? 'teacher-1'].short}老师负责</span>
                      </button>
                      {item.id === module?.id && <div class="step-list">{item.steps.map((lesson, index) => this.renderStepListItem(lesson, index))}</div>}
                    </section>
                  ))}
                </div>
                <div class="module-editor">
                  <ion-input disabled={this.project.status === 'frozen' || !this.canEditCurrentModule} label="当前模块标题" labelPlacement="stacked" class="studio-input" value={module?.title ?? ''} onIonInput={(event) => this.updateCurrentModule({ title: event.detail.value ?? '' })} />
                  <ion-textarea disabled={this.project.status === 'frozen' || !this.canEditCurrentModule} autoGrow label="模块目标" labelPlacement="stacked" class="studio-input" value={module?.summary ?? ''} onIonInput={(event) => this.updateCurrentModule({ summary: event.detail.value ?? '' })} />
                </div>
              </aside>

              <section class="editor-panel">
                <div class="panel-switcher">
                  <button class={this.activePanel === 'editor' ? 'active' : ''} onClick={() => { this.activePanel = 'editor'; }}>步骤编排</button>
                  <button class={this.activePanel === 'checks' ? 'active' : ''} onClick={() => { this.activePanel = 'checks'; }}>发布前检查 <span>{this.checks.length}</span></button>
                </div>
                <div class="editor-scroll">{this.activePanel === 'editor' ? this.renderStepEditor() : this.renderChecks()}</div>
              </section>

              {this.renderPreview()}
            </main>
          </ion-content>
          <ion-toast isOpen={Boolean(this.toast)} message={this.toast?.message} color={this.toast?.color} duration={3200} onDidDismiss={() => { this.toast = undefined; }} />
        </ion-app>
      </Host>
    );
  }
}
