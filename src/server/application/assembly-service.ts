/**
 * 组装服务（文档 §5.5「完成 Artifact」+ §6.3 + D-16 + D-19 + AC-013）。
 *
 * 组装本身是 `domain/assembly.ts` 的纯函数，本文件只做三件事：
 * 取数据、**判空**、把结果原子落库。
 *
 * ## D-19：空产物必须在这一层被拒绝
 *
 * `assembleMarkdownConcatV1` 对「所有槽位都被排除或都无正文」返回 `''` 而不抛错，
 * 这是刻意的：判断「一个空产物是否可以落库」需要任务上下文（当前阶段、
 * 模板是不是本来就全是工作槽位），而那个纯函数手上只有 `Slot[]`。
 * 把业务规则藏进纯函数还会顺带打死单元测试里的空输入用例。
 *
 * 于是这条规则的落点唯一，就是本文件。落一份 0 字节的 chapter.md 并把任务标成
 * 「已完成」，是整个系统里最坏的一种失败——用户拿到一个空文件，
 * 而所有状态都显示一切正常。
 *
 * ## §8.8：进 Assembly 前必须断言全部内容槽已完成
 *
 * `allContentSlotsCompleted` 在调度层已经判过一次（`slot-scheduler`），
 * 这里再判一次不是冗余：assembly 也可能被 retry 路径直接触发（§8.7
 * 「assembly 失败：什么都不用重置，直接重跑组装」），那条路不经过调度器。
 * 断言的代价可忽略，而静默的状态损坏在内容生产场景里代价极高。
 *
 * ## 重跑组装：先删后插，不 UPSERT
 *
 * `artifacts.task_id` 上有 UNIQUE。`ArtifactRepo` 刻意不提供 UPSERT——
 * UPSERT 会让「产物被替换过」这件事不留痕迹，而 `ASSEMBLY_FAILED` 之后的重试
 * 恰恰需要能看出产物换过一次。删除与插入在同一事务内，不存在「删了没插上」的窗口。
 */

import { randomUUID } from 'node:crypto';
import { ForgeError } from '@shared/errors.ts';
import {
  assembleMarkdownConcatV1,
  assemblyOrder,
  computeArtifactChecksum,
} from '@server/domain/assembly.ts';
import { allContentSlotsCompleted } from '@server/domain/readiness.ts';
import type { Artifact } from '@server/infrastructure/database/repositories/index.ts';
import type { UnitOfWork, UnitOfWorkHandle } from '@server/infrastructure/uow.ts';
import type { SnapshotService } from './snapshot-service.ts';
import type { TraceService } from './trace-service.ts';

export interface AssemblyService {
  /**
   * §5.5「完成 Artifact」：组装 → 判空 → `INSERT artifacts` +
   * `UPDATE tasks(phase='done', status='completed', artifact_id)` + trace，全在一个事务内。
   *
   * 失败时（前置条件不满足 / 空产物）**先把任务落成 failed 再抛**，
   * 错误消息已成文（D-19），可直接展示。
   */
  assemble(taskId: string): Artifact;
}

export interface AssemblyServiceOptions {
  uow: UnitOfWorkHandle<UnitOfWork>;
  snapshots: SnapshotService;
  traces: TraceService;
  newId?: () => string;
}

export function createAssemblyService(options: AssemblyServiceOptions): AssemblyService {
  const { uow, snapshots, traces } = options;
  const newId = options.newId ?? ((): string => randomUUID());

  /**
   * 组装失败的统一出口：把成文原因写进 `tasks.error_message`（D-19），记 trace，然后抛。
   *
   * 写库与抛错分成两步而不是「抛了让上层写」：上层要写就得自己再拼一次文案，
   * 两处文案迟早不一致，而附录 B.1 第 12 行直接展示 `task.errorMessage`。
   */
  const failAssembly = (taskId: string, reason: string): never => {
    traces.runWithTraces((repos, trace) => {
      repos.tasks.update(taskId, {
        status: 'failed',
        phase: 'assembly',
        activeExecutionId: null,
        errorCode: 'ASSEMBLY_FAILED',
        errorMessage: reason,
      });
      trace.record({
        taskId,
        executionId: null,
        actor: 'system',
        kind: 'assembly_started',
        title: '组装未能完成',
        summary: reason,
      });
    });
    throw new ForgeError(
      'ASSEMBLY_FAILED',
      reason,
      `task:${taskId}`,
      '点击重试，已完成槽位内容保留，只重新执行组装',
    );
  };

  return {
    assemble(taskId) {
      // --- 事务外：读快照与槽位、跑纯函数组装。全部只读 ---
      const snapshot = snapshots.readSnapshot(taskId);
      const slots = uow.repositories.slots.listByTask(taskId);

      if (slots.length === 0) {
        return failAssembly(taskId, '任务还没有结构，无法组装产物');
      }
      // §8.8 的断言。工作槽位（includeInArtifact=false）同样计入——
      // 它不进产物，但下游要读它（D-16）。
      if (!allContentSlotsCompleted(slots)) {
        const pending = slots
          .filter((slot) => slot.contentBearing && slot.status !== 'completed')
          .map((slot) => slot.slotId);
        return failAssembly(
          taskId,
          `还有槽位未完成，不能组装：${pending.join('、')}（违反 FR-ASM-001）`,
        );
      }

      const content = assembleMarkdownConcatV1(slots);
      if (content === '') {
        // D-19：这条判断的全部理由见文件头。给出可执行的诊断而不是一句「组装失败」——
        // 用户能改的只有模板里的 includeInArtifact，报错就该指向它。
        return failAssembly(
          taskId,
          '组装结果为空：本任务没有任何进入产物的槽位内容。' +
            '请检查模板中各槽位类型的 includeInArtifact 设置（标为 false 的子树整棵不进正文）',
        );
      }

      const order = assemblyOrder(slots);
      const artifactId = newId();
      const { output } = snapshot.compiled;

      // --- 事务内：只做写入 ---
      return traces.runWithTraces((repos, trace) => {
        // 重跑组装时先清掉旧产物；首次组装时 changes = 0，无副作用。
        repos.artifacts.deleteByTask(taskId);
        const artifact = repos.artifacts.insert({
          id: artifactId,
          taskId,
          fileName: output.fileName,
          mediaType: output.mediaType,
          content,
          // 校验和由 domain 算（`sha256:` 前缀是存储格式的一部分，§6.3），仓储不自己算
          checksum: computeArtifactChecksum(content),
        });
        repos.tasks.update(taskId, {
          status: 'completed',
          phase: 'done',
          activeExecutionId: null,
          artifactId,
          errorCode: null,
          errorMessage: null,
        });
        trace.record({
          taskId,
          executionId: null,
          actor: 'system',
          kind: 'artifact_created',
          title: '产物已生成',
          summary: `${output.fileName} · ${artifact.byteSize} 字节 · ${order.length} 个槽位`,
          payload: {
            fileName: output.fileName,
            mediaType: output.mediaType,
            byteSize: artifact.byteSize,
            checksum: artifact.checksum,
            // D-16 影响面第 7 条：工作槽位不出现在组装列表里
            assemblyOrder: order,
          },
        });
        return artifact;
      });
    },
  };
}
