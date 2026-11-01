import type { ProgramId } from '@dafeiyu/contracts';
import type { RoomRuntime } from './room-runtime.js';

/**
 * 房间注册表：按需创建并缓存房间运行时。
 *
 * 边界：
 * - 每个房间独立 Stage / Scheduler / Programs / Ingress（互不影响）；
 * - 房间数量有上限，防止外部事件用任意 roomId 撑爆内存；
 * - 房间空闲超时后可被回收（可选，默认保留，便于复盘）。
 */
export type RoomRegistryOptions = {
  createRoom: (roomId: string) => RoomRuntime;
  /** 同时存在的房间上限。 */
  maxRooms: number;
};

export class RoomRegistry {
  private readonly rooms = new Map<string, RoomRuntime>();

  constructor(private readonly options: RoomRegistryOptions) {}

  get size(): number {
    return this.rooms.size;
  }

  roomIds(): string[] {
    return [...this.rooms.keys()];
  }

  /**
   * 取得（或创建）房间运行时。
   * 超过上限时返回 null，调用方应拒绝该事件（而不是静默丢弃或无限增长）。
   */
  get(roomId: string): RoomRuntime | null {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    if (this.rooms.size >= this.options.maxRooms) return null;
    const created = this.options.createRoom(roomId);
    this.rooms.set(roomId, created);
    return created;
  }

  /** 已存在的房间；不存在返回 null（不会创建）。 */
  peek(roomId: string): RoomRuntime | null {
    return this.rooms.get(roomId) ?? null;
  }

  /** 所有房间（用于广播关闭、指标汇总）。 */
  all(): RoomRuntime[] {
    return [...this.rooms.values()];
  }

  async shutdownAll(): Promise<void> {
    const rooms = this.all();
    this.rooms.clear();
    await Promise.all(rooms.map((room) => room.scheduler.shutdown()));
  }

  /** 汇总各房间队列深度，供控制台/监控。 */
  queueSummary(): { roomId: string; queued: number; busy: boolean; speaking: boolean }[] {
    return this.all().map((room) => ({
      roomId: room.roomId,
      queued: room.scheduler.queueDepth,
      busy: room.scheduler.isBusy,
      speaking: room.stage.snapshot().activeSpeech !== null,
    }));
  }
}

export type { ProgramId, RoomRuntime };
