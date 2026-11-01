/**
 * 单一音频出口。
 *
 * P2：有音频时用 HTMLAudioElement + Web Audio 播放，
 * 由**实际播放时钟**驱动字幕与口型；无音频（audioUrl=null）时退回本地估算时钟。
 *
 * 约束：
 * - 一个页面只有一个出口实例，避免串音；
 * - stop() 立即停止并清理定时器与音频节点；
 * - 播放失败明确返回 'failed'，不静默假装在播。
 */
export type PlaybackHandle = {
  /** 播放进度毫秒（真实音频时钟或估算时钟）。 */
  positionMs: number;
  stop: () => void;
  /** 播完/被停止时 resolve。 */
  done: Promise<'ended' | 'stopped' | 'failed'>;
  /** 是否使用了真实音频。 */
  hasAudio: boolean;
};

export type AudioOutlet = {
  play: (input: {
    speechId: string;
    text: string;
    audioUrl: string | null;
    audioDurationMs?: number | null;
  }) => PlaybackHandle;
  isPlaying: () => boolean;
  /** 显式激活音频上下文（浏览器自动播放策略要求用户手势）。 */
  activate: () => Promise<boolean>;
};

const MS_PER_CHAR = 130;
const MIN_DURATION_MS = 900;

export function createAudioOutlet(): AudioOutlet {
  let current: { speechId: string; stop: () => void } | null = null;
  let audioContext: AudioContext | null = null;
  let activated = false;

  const ensureContext = (): AudioContext | null => {
    if (audioContext) return audioContext;
    const Ctor =
      typeof window !== 'undefined'
        ? (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    if (!Ctor) return null;
    try {
      audioContext = new Ctor();
    } catch {
      audioContext = null;
    }
    return audioContext;
  };

  return {
    isPlaying: () => current !== null,
    activate: async () => {
      const context = ensureContext();
      if (!context) {
        activated = false;
        return false;
      }
      try {
        if (context.state === 'suspended') await context.resume();
        activated = context.state === 'running';
        return activated;
      } catch {
        activated = false;
        return false;
      }
    },
    play({ speechId, text, audioUrl, audioDurationMs }) {
      // 单出口：新语音先停旧的，避免重叠。
      current?.stop();

      // 占位必须早于 Promise executor：
      // executor 里存在同步 finish('failed') 分支（环境不支持 play() 等），
      // 若此时 current 尚未指向本句，finish 的清理判断会失效，
      // 结果 current 被赋值成一个已结束的句柄 → isPlaying() 永久 true → 整场静音。
      const slot: { speechId: string; stop: () => void } = {
        speechId,
        stop: () => undefined,
      };
      current = slot;

      let settled = false;
      let positionMs = 0;
      let stopFn: () => void = () => undefined;
      let timer: ReturnType<typeof setInterval> | null = null;
      let audio: HTMLAudioElement | null = null;
      const startedAt = performance.now();

      const done = new Promise<'ended' | 'stopped' | 'failed'>((resolve) => {
        const finish = (reason: 'ended' | 'stopped' | 'failed') => {
          if (settled) return;
          settled = true;
          if (timer) clearInterval(timer);
          if (audio) {
            audio.pause();
            audio.src = '';
            audio = null;
          }
          if (current === slot) current = null;
          resolve(reason);
        };

        const estimated = Math.max(
          MIN_DURATION_MS,
          audioDurationMs ?? text.length * MS_PER_CHAR,
        );

        if (audioUrl !== null) {
          audio = new Audio(audioUrl);
          audio.preload = 'auto';

          audio.addEventListener('timeupdate', () => {
            if (settled || !audio) return;
            positionMs = Math.round(audio.currentTime * 1000);
          });
          audio.addEventListener('ended', () => {
            if (settled) return;
            positionMs = estimated;
            finish('ended');
          });
          audio.addEventListener('error', () => {
            if (settled) return;
            // 音频不可用时明确失败，由上层决定是否退回字幕模式。
            finish('failed');
          });

          // 估算时钟作为兜底：即使 timeupdate 不触发也能推进字幕。
          timer = setInterval(() => {
            if (settled) return;
            if (audio && audio.readyState >= 2) {
              positionMs = Math.round(audio.currentTime * 1000);
            } else {
              positionMs = Math.round(performance.now() - startedAt);
            }
            // 只在音频完全没加载成功时兜底结束；否则以 ended 事件为准，
            // 避免估算时长比真实音频短、提前发 ended 回执。
            if (!audio || audio.readyState === 0) {
              if (positionMs >= estimated) finish('ended');
            }
          }, 80);

          stopFn = () => {
            positionMs = audio ? Math.round(audio.currentTime * 1000) : positionMs;
            finish('stopped');
          };

          // jsdom 等环境可能没有实现 play()，必须防御性处理。
          const playResult = audio.play?.();
          if (playResult && typeof playResult.catch === 'function') {
            void playResult.catch(() => {
              // 自动播放被拦截或文件不可用：不假装在播。
              finish('failed');
            });
          } else if (!playResult) {
            // 环境不支持播放：明确失败，而不是假装在播。
            finish('failed');
          }
        } else {
          timer = setInterval(() => {
            positionMs = Math.round(performance.now() - startedAt);
            if (positionMs >= estimated) finish('ended');
          }, 80);
          stopFn = () => {
            positionMs = Math.round(performance.now() - startedAt);
            finish('stopped');
          };
        }
      });

      slot.stop = stopFn;

      return {
        get positionMs() {
          return positionMs;
        },
        stop: () => stopFn(),
        done,
        hasAudio: audioUrl !== null,
      };
    },
  };
}

export function estimateDurationMs(text: string): number {
  return Math.max(MIN_DURATION_MS, text.length * MS_PER_CHAR);
}
