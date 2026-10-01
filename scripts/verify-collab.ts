/* 临时端到端验证：模拟 localStorage 下的两个窗口协作 */
import { createDemoProject, migrateLegacyProject, reconcileReferences, LEGACY_STORAGE_KEY, STORAGE_KEY, type CourseProject, type PendingOperation } from '../src/models';
import {
  SHARED_KEY,
  bootstrapShared,
  clientIdForTeacher,
  loadShared,
  pullShared,
  replayOutbox,
  saveSlice,
  saveShared,
  saveOutbox,
  applyOperation,
  type SharedDoc,
} from '../src/collab';

function createStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key: string) => map.has(key) ? map.get(key)! : null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key); },
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
  };
}

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function opOf(teacher: 'teacher-lin' | 'teacher-zhao', payload: PendingOperation['payload']): PendingOperation {
  return {
    id: `op-${Math.random().toString(36).slice(2)}`,
    clientId: clientIdForTeacher(teacher),
    teacherId: teacher,
    at: new Date().toISOString(),
    label: 'test',
    payload,
  };
}

// —— 场景一：两个窗口各改归属模块，同时保存互不覆盖 ——
(function scenarioSliceSave() {
  console.log('\n[场景一] 双窗口切片保存互不覆盖');
  (globalThis as any).localStorage = createStorage();
  const shared = bootstrapShared(createDemoProject());

  // 窗口 A：林老师（模块一）改 step-1-1 标题
  const workA = pullShared(shared, clone(shared.project), 'teacher-lin');
  const module1 = workA.modules.find((m) => m.id === 'module-1')!;
  const step11 = module1.steps.find((s) => s.id === 'step-1-1')!;
  step11.title = '【林老师改】你好示范';
  let docA = saveSlice(loadShared()!, workA, 'teacher-lin');

  // 窗口 B：赵老师（模块二）基于稍早的共享副本编辑（模拟并发），改 step-2-1
  const workB = pullShared(shared, clone(shared.project), 'teacher-zhao');
  const module2 = workB.modules.find((m) => m.id === 'module-2')!;
  const step21 = module2.steps.find((s) => s.id === 'step-2-1')!;
  step21.title = '【赵老师改】数字手形';
  // B 保存时读入 A 已写入的共享，再保存自己的切片
  const beforeB = loadShared()!;
  const mergedB = pullShared(beforeB, workB, 'teacher-zhao');
  saveSlice(beforeB, mergedB, 'teacher-zhao');

  const finalDoc = loadShared()!;
  const finalM1 = finalDoc.project.modules.find((m) => m.id === 'module-1')!;
  const finalM2 = finalDoc.project.modules.find((m) => m.id === 'module-2')!;
  assert(finalM1.steps.find((s) => s.id === 'step-1-1')!.title === '【林老师改】你好示范', '林老师对模块一的改动保留');
  assert(finalM2.steps.find((s) => s.id === 'step-2-1')!.title === '【赵老师改】数字手形', '赵老师对模块二的改动保留，没有被 A 的保存盖掉');
  assert(finalDoc.project.modules.length === 2, '两个模块都还在');
  void docA;
})();

// —— 场景二：跨模块引用；删除/挪动被引用步骤 → 引用挂起 ——
(function scenarioReferenceSuspension() {
  console.log('\n[场景二] 跨模块前置被删除/挪动时挂起等待确认');
  (globalThis as any).localStorage = createStorage();
  const shared = bootstrapShared(createDemoProject());

  // 演示数据已有 ref-demo-1：step-2-1 -> step-1-3
  assert(shared.project.references[0].status === 'active', '初始跨模块引用有效');

  // 林老师删除被引用的 step-1-3
  const opDelete = opOf('teacher-lin', { type: 'deleteStep', moduleId: 'module-1', stepId: 'step-1-3' });
  const afterDelete = applyOperation(shared.project, opDelete);
  assert(!afterDelete.skipped, '删除操作生效');
  const docAfterDelete: SharedDoc = { project: afterDelete.project, updatedAt: new Date().toISOString() };
  saveShared(docAfterDelete);

  // 赵老师窗口拉取
  const workB = pullShared(docAfterDelete, clone(docAfterDelete.project), 'teacher-zhao');
  const reconciled = reconcileReferences(workB, { deletedStepIds: ['step-1-3'] });
  const ref = reconciled.project.references.find((r) => r.id === 'ref-demo-1')!;
  assert(ref.status === 'suspended', '被引用步骤删除后，赵老师一侧看到引用挂起');
  assert(ref.suspendReason.includes('删除'), '挂起原因说明是删除');

  // 重新搭一个场景：挪动导致顺序倒挂
  (globalThis as any).localStorage = createStorage();
  const shared2 = bootstrapShared(createDemoProject());
  // step-2-1 前置 step-1-3；把 step-1-3 移动会怎样？跨模块顺序按模块序，模块内移动不越模块。
  // 改为：赵老师先让 step-2-2 引用 module-1 的 step-1-1（顺序合法），然后林老师在模块一内把 1-1 挪到末尾？
  // 模块一永远在模块二之前，因此只有“跨模块目标变成同步骤之后”通过新增模块顺序变化触发。
  const ref2 = {
    id: 'ref-2', stepId: 'step-2-2', ownerModuleId: 'module-2',
    targetStepId: 'step-1-1', targetModuleId: 'module-1',
    status: 'active' as const, suspendReason: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const withRef = applyOperation(shared2.project, opOf('teacher-zhao', { type: 'addReference', reference: ref2 }));
  // 把 module-1 挪到 module-2 之后（通过替换模块顺序，模拟结构性调整）
  const reordered: CourseProject = {
    ...withRef.project,
    modules: [...[...withRef.project.modules].reverse()],
  };
  const result = reconcileReferences(reordered, { movedStepIds: ['step-1-1'] });
  const movedRef = result.project.references.find((r) => r.id === 'ref-2')!;
  assert(movedRef.status === 'suspended', '被引用步骤挪动导致顺序倒挂时引用挂起');
})();

// —— 场景三：断网照编，恢复后补回；已对上的不动 ——
(function scenarioOfflineReplay() {
  console.log('\n[场景三] 离线编辑与恢复后回放');
  (globalThis as any).localStorage = createStorage();
  const shared = bootstrapShared(createDemoProject());

  const teacher = 'teacher-zhao' as const;
  const clientId = clientIdForTeacher(teacher);
  // 赵老师离线期间：改标题（两次编辑）、新增一个步骤
  const outbox: PendingOperation[] = [
    opOf(teacher, { type: 'patchStep', moduleId: 'module-2', stepId: 'step-2-2', fields: { title: '离线改的标题' } }),
    opOf(teacher, { type: 'patchStep', moduleId: 'module-2', stepId: 'step-2-2', fields: { title: '离线改的标题' } }), // 重复：已对上
    opOf(teacher, {
      type: 'addStep', moduleId: 'module-2',
      step: {
        id: 'step-offline-1', title: '离线新增练习', kind: '练习', duration: 40, demoTitle: '', demoUrl: '',
        handshape: '', gestureZone: '中央', caption: '', captionPosition: '下方安全区', camera: '正面',
        commonMistakes: [], exercise: 'x', exerciseFeedback: 'y', altText: 'z', prerequisiteId: 'step-2-2',
        difficulty: '进阶', cuePoints: [],
      },
    }),
  ];
  saveOutbox(clientId, outbox);

  const result = replayOutbox(shared, outbox);
  assert(result.applied === 2, `实际补回 2 项改动（得到 ${result.applied}）`);
  assert(result.skipped === 1, `重复且已对上的改动跳过 1 项（得到 ${result.skipped}）`);
  const m2 = result.doc.project.modules.find((m) => m.id === 'module-2')!;
  assert(m2.steps.find((s) => s.id === 'step-2-2')!.title === '离线改的标题', '离线期间的标题修改补回课程');
  assert(m2.steps.some((s) => s.id === 'step-offline-1'), '离线新增的步骤补回课程');
  // 回放幂等：再放一次全部跳过
  const second = replayOutbox(result.doc, outbox);
  assert(second.applied === 0 && second.skipped === 3, `重复回放全部跳过（applied=${second.applied}, skipped=${second.skipped}）`);

  // 林老师模块不受赵老师离线重放影响
  const m1 = result.doc.project.modules.find((m) => m.id === 'module-1')!;
  assert(m1.steps.find((s) => s.id === 'step-1-1')!.title.startsWith('观察'), '另一位老师的模块保持原样');
})();

// —— 场景四：v1 老课程迁移；老课程仍可编辑 ——
(function scenarioMigration() {
  console.log('\n[场景四] v1 老数据迁移到归属 + 引用模型');
  (globalThis as any).localStorage = createStorage();
  const v1 = {
    id: 'old-course',
    title: '老课程',
    teacher: '王老师',
    audience: '社区班',
    status: 'draft',
    selectedModuleId: 'm-a',
    selectedStepId: 's-a2',
    modules: [
      {
        id: 'm-a', title: '第一模块', summary: '旧', color: '#000',
        steps: [
          { id: 's-a1', title: '旧步骤1', kind: '示范', duration: 30, demoTitle: '', demoUrl: '', handshape: '', gestureZone: '中央', caption: 'c', captionPosition: '下方安全区', camera: '正面', commonMistakes: ['m'], exercise: '', exerciseFeedback: '', altText: 'alt', prerequisiteId: '', difficulty: '入门', cuePoints: [] },
          { id: 's-a2', title: '旧步骤2', kind: '讲解', duration: 30, demoTitle: '', demoUrl: '', handshape: '', gestureZone: '中央', caption: 'c2', captionPosition: '下方安全区', camera: '正面', commonMistakes: [], exercise: '', exerciseFeedback: '', altText: 'alt2', prerequisiteId: 's-a1', difficulty: '入门', cuePoints: [] },
        ],
      },
      {
        id: 'm-b', title: '第二模块', summary: '旧', color: '#111',
        steps: [
          // v1 里残留一个跨模块前置 s-a1
          { id: 's-b1', title: '旧步骤3', kind: '练习', duration: 30, demoTitle: '', demoUrl: '', handshape: '', gestureZone: '中央', caption: '', captionPosition: '下方安全区', camera: '正面', commonMistakes: [], exercise: 'e', exerciseFeedback: 'f', altText: 'alt3', prerequisiteId: 's-a1', difficulty: '挑战', cuePoints: [] },
        ],
      },
    ],
    frozenVersions: [],
    lastSavedAt: new Date().toISOString(),
    revision: 1,
  };
  localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(v1));
  // 先确保没有 v2/shared 数据
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(SHARED_KEY);

  const doc = bootstrapShared({ ...createDemoProject(), modules: [] } as CourseProject);
  assert(doc.project.schemaVersion === 2, '迁移后模型版本为 2');
  assert(doc.project.title === '老课程', '课程内容保留');
  assert(doc.project.modules[0].ownerId === 'teacher-lin', '模块一归属林老师');
  assert(doc.project.modules[1].ownerId === 'teacher-zhao', '模块二归属赵老师');
  assert(doc.project.modules[0].steps[1].prerequisiteId === 's-a1', '模块内部前置原样保留');
  const migratedRef = doc.project.references.find((r) => r.stepId === 's-b1');
  assert(Boolean(migratedRef), 'v1 残留的跨模块前置迁移为引用');
  assert(migratedRef!.status === 'suspended', '迁移来的跨模块引用默认挂起待确认');

  // 老课程迁移后仍可编辑：林老师修改步骤并能补回共享
  const op = opOf('teacher-lin', { type: 'patchStep', moduleId: 'm-a', stepId: 's-a1', fields: { title: '迁移后继续编辑' } });
  const res = applyOperation(doc.project, op);
  assert(!res.skipped && res.project.modules[0].steps[0].title === '迁移后继续编辑', '迁移后的老课程照常可编辑');

  // 直接迁移无效 JSON 返回 undefined
  assert(migrateLegacyProject('not-json') === undefined, '损坏数据安全返回 undefined');
})();

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
