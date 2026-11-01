import type { Harness, TurnOutcome } from '../harness/harness.js';

/**
 * 调度器：有界队列 + 单讲话者 + 取消。
 *
 * 不逐条弹幕调模型：普通弹幕进入队列，按队列上限背压；
 * 同一时刻只有一个 turn 在规划/执行，避免串音。
 */
export type QueuedTurn = {
  turnId: string;
  traceId: string;
  sessionId: string;
  roomId: string;
  /** 触发本轮的事件 ID，便于从 turn 反查原始事件。 */
  triggerEventId: string | null;
  /** 观众 ID：用于加载观众级记忆；匿名时为 null。 */
  viewerId: string | null;
  viewerName: string | null;
  text: string;
};

export type SchedulerEvents = {
  onTurnStarted?: (turn: QueuedTurn) => void;
  onTurnFinished?: (turn: QueuedTurn, outcome: TurnOutcome | null, error: string | null) => void;
};

export class Scheduler {
  private readonly pending: QueuedTurn[] = [];
  private running = false;
  private activeController: AbortController | null = null;
  private activeTurn: QueuedTurn | null = null;
  private closed = false;

  constructor(
    private readonly options: {
      harness: Harness;
      maxPending: number;
      events?: SchedulerEvents;
    },
  ) {}

  get queueDepth(): number {
    return this.pending.length;
  }

  get isBusy(): boolean {
    return this.running;
  }

  /** 预检容量：入队前判断，避免“已记去重却入队失败”。 */
  hasCapacity(): boolean {
    return !this.closed && this.pending.length < this.options.maxPending;
  }

  get currentTurn(): QueuedTurn | null {
    return this.activeTurn;
  }

  /**
   * 入队。返回 false 表示队列已满（背压），调用方应告知观众稍后再试。
   */
  enqueue(turn: QueuedTurn): boolean {
    if (this.closed) return false;
    if (this.pending.length >= this.options.maxPending) return false;
    this.pending.push(turn);
    void this.drain();
    return true;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0 && !this.closed) {
        const turn = this.pending.shift();
        if (!turn) break;
        this.activeTurn = turn;
        const controller = new AbortController();
        this.activeController = controller;
        this.options.events?.onTurnStarted?.(turn);
        try {
          const outcome = await this.options.harness.runTurn({
            turnId: turn.turnId,
            traceId: turn.traceId,
            sessionId: turn.sessionId,
            roomId: turn.roomId,
            triggerEventId: turn.triggerEventId,
            viewerId: turn.viewerId,
            viewerName: turn.viewerName,
            text: turn.text,
            signal: controller.signal,
          });
          this.options.events?.onTurnFinished?.(turn, outcome, null);
        } catch (error) {
          this.options.events?.onTurnFinished?.(
            turn,
            null,
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          this.activeController = null;
          this.activeTurn = null;
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** 取消当前轮：停止模型/工具，队列保留（主播手动接管时可再清空）。 */
  cancelActive(reason = 'manual'): boolean {
    if (!this.activeController) return false;
    this.activeController.abort(reason);
    return true;
  }

  clearPending(): number {
    const count = this.pending.length;
    this.pending.length = 0;
    return count;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.cancelActive('shutdown');
    this.clearPending();
    // 给正在执行的轮次一点时间落库，不阻塞退出太久。
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
