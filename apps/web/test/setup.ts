import { vi } from 'vitest';

/**
 * jsdom 没有 Canvas 2D 与 requestAnimationFrame 的真实实现。
 * 这里提供最小 stub，让舞台组件能挂载；不验证绘制内容
 * （绘制正确性由 e2e 在真实浏览器里覆盖）。
 */
const noop = () => undefined;

const context2d = {
  setTransform: noop,
  clearRect: noop,
  createLinearGradient: () => ({ addColorStop: noop }),
  fillRect: noop,
  beginPath: noop,
  ellipse: noop,
  fill: noop,
  moveTo: noop,
  quadraticCurveTo: noop,
  closePath: noop,
  arc: noop,
  fillStyle: '',
};

HTMLCanvasElement.prototype.getContext = vi.fn(() => context2d) as never;

if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 16) as unknown as number) as never;
}
if (!globalThis.cancelAnimationFrame) {
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as never;
}

// jsdom 未实现媒体播放；返回 rejected Promise 以便走失败分支。
if (!HTMLMediaElement.prototype.play) {
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.reject(new Error('not implemented')));
  HTMLMediaElement.prototype.pause = vi.fn();
}
