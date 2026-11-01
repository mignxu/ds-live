import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Souvenir } from '@dafeiyu/contracts';
import { createSignatureArtwork, type SignatureArtifact } from '../programs/programs.js';
import type { Repository } from '../storage/repository.js';
import type { ToolImpl } from './registry.js';

/**
 * signature.create：生成原创笔迹签名并归档为纪念品。
 *
 * 边界：
 * - 这是**写操作**：会落文件、写 souvenirs 表，因此不在模型工具白名单里。
 *   只能由观众明确申请（弹幕命令/按钮）触发，模型不能自由调用。
 * - 笔迹是代码生成的原创路径，不是真实手写，也不冒称真人手写。
 * - 不写任意路径：输出目录由配置注入，文件名由服务端生成。
 */
const ArgumentsSchema = z.object({
  text: z.string().trim().min(1).max(12),
  viewerName: z.string().trim().max(40).nullable().optional(),
});

export type SignatureToolDeps = {
  repository: Repository;
  outputDir: string;
  publicPrefix: string;
  roomId: string;
  now?: () => Date;
};

export type SignatureToolResult = {
  artifact: SignatureArtifact;
  souvenir: Souvenir;
};

/** 删除指定 publicId 的签名文件；失败忽略（清理是尽力而为）。 */
function removeArtifact(outputDir: string, publicId: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(publicId)) return;
  try {
    unlinkSync(join(outputDir, `sig-${publicId}.svg`));
  } catch {
    // 文件不存在或已被清理，忽略
  }
}

export function createSignatureTool(deps: SignatureToolDeps): ToolImpl {
  return {
    definition: {
      name: 'signature.create',
      description:
        '为观众生成一张原创笔迹签名图并归档为纪念品。参数 text 为要签的文字（最多 12 字）。写操作。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要签的文字' },
          viewerName: { type: 'string', description: '申请者昵称（可选）' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      readOnly: false,
    },
    argumentsSchema: ArgumentsSchema,
    async execute(args, context) {
      const parsed = ArgumentsSchema.parse(args);
      if (context.signal.aborted) {
        return {
          status: 'error',
          data: null,
          source: 'local',
          isMock: false,
          errorCode: 'cancelled',
          retryable: false,
          message: '已取消',
        };
      }

      const publicId = randomUUID().replace(/-/g, '').slice(0, 16);
      const createdAt = (deps.now ?? (() => new Date()))().toISOString();
      // 先构造元数据（不落盘），再写库，最后落盘：
      // 写库失败 → 没有文件；落盘失败 → 删除数据库记录。
      const imageUrl = `${deps.publicPrefix}/sig-${publicId}.svg`;
      const souvenir: Souvenir = {
        publicId,
        kind: 'signature',
        title: `大肥鱼签名：${parsed.text}`,
        // 公开纪念品不写观众昵称：/api/souvenirs 无鉴权，
        // 昵称虽非 viewerId，但仍属观众信息，默认不公开。
        text: `签名：${parsed.text}（原创笔迹，非真人手写）`,
        imageUrl,
        isMock: true,
        program: 'signature',
        createdAt,
        data: null,
      };
      let stored = false;
      try {
        stored = deps.repository.insertSouvenir({
          souvenir,
          imagePath: imageUrl,
          roomId: deps.roomId,
        });
      } catch (error) {
        // 写库失败：删除刚生成的 SVG，避免媒体目录无限增长。
        removeArtifact(deps.outputDir, publicId);
        return {
          status: 'error',
          data: null,
          source: 'local',
          isMock: false,
          errorCode: 'upstream_error',
          retryable: true,
          message: error instanceof Error ? error.message.slice(0, 200) : '写库失败',
        };
      }
      if (!stored) {
        // publicId 冲突（几乎不可能）：明确失败，不覆盖已有作品。
        removeArtifact(deps.outputDir, publicId);
        return {
          status: 'error',
          data: null,
          source: 'local',
          isMock: false,
          errorCode: 'upstream_error',
          retryable: true,
          message: '纪念品 ID 冲突，请重试',
        };
      }

      // 落盘：失败则回滚数据库记录，避免“有元数据没图片”。
      let artifact;
      try {
        artifact = createSignatureArtwork({
          publicId,
          text: parsed.text,
          outputDir: deps.outputDir,
          publicPrefix: deps.publicPrefix,
        });
      } catch (error) {
        deps.repository.deleteSouvenir(publicId);
        return {
          status: 'error',
          data: null,
          source: 'local',
          isMock: false,
          errorCode: 'upstream_error',
          retryable: true,
          message: error instanceof Error ? error.message.slice(0, 200) : '写文件失败',
        };
      }

      // 补充笔迹元数据（此前未知）
      deps.repository.updateSouvenirData(publicId, {
        strokes: artifact.strokes.length,
        width: artifact.width,
        height: artifact.height,
      });

      return {
        status: 'ok',
        data: {
          publicId,
          text: artifact.text,
          imageUrl: artifact.imageUrl,
          souvenirUrl: `/souvenirs/${publicId}`,
          note: '原创笔迹占位，非真人手写',
        },
        source: 'local',
        isMock: true,
        errorCode: null,
        retryable: false,
        message: null,
      };
    },
  };
}
