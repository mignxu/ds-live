import type { Souvenir, SouvenirList } from '@dafeiyu/contracts';
import type { Repository } from '../storage/repository.js';

/**
 * 纪念品服务。
 *
 * 边界：
 * - 只读公开作品；publicId 随机且不可枚举，不用平台 viewerId 授权。
 * - 不暴露服务器文件路径：对外只给相对 media URL。
 * - 领取纪念品不影响当场参与、计分或结算。
 */
export type SouvenirServiceOptions = {
  repository: Repository;
  storageDir: string;
  roomId: string;
};

export class SouvenirService {
  constructor(private readonly options: SouvenirServiceOptions) {}

  get(publicId: string): Souvenir | null {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(publicId)) return null;
    return this.options.repository.findPublicSouvenir(publicId);
  }

  list(limit = 20, offset = 0): SouvenirList {
    const safeLimit = Math.max(1, Math.min(50, limit));
    const safeOffset = Math.max(0, offset);
    return this.options.repository.listPublicSouvenirs(safeLimit, safeOffset);
  }

  get storageDir(): string {
    return this.options.storageDir;
  }
}
