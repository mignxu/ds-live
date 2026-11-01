/**
 * 原创占位角色：Canvas 2D 绘制，不依赖任何 Live2D 模型或第三方素材。
 * 仅用于技术验收（口型/字幕/播放时钟），不是最终外观。
 *
 * 形状参数化，后续替换正式美术时只改这个文件。
 */
export type CharacterRenderer = {
  /** 0..1，用于口型开合。 */
  setMouthOpen: (value: number) => void;
  /** 0..1，说话时轻微浮动。 */
  setEnergy: (value: number) => void;
  start: () => void;
  stop: () => void;
};

export function createCharacterRenderer(canvas: HTMLCanvasElement): CharacterRenderer {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D');

  let mouthOpen = 0;
  let energy = 0;
  let frame = 0;
  let rafId: number | null = null;
  let lastTs = 0;

  const draw = (ts: number) => {
    const dt = lastTs === 0 ? 16 : Math.min(48, ts - lastTs);
    lastTs = ts;
    frame += dt / 1000;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 640;
    const cssHeight = canvas.clientHeight || 480;
    if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const cx = cssWidth / 2;
    const cy = cssHeight / 2 + Math.sin(frame * 1.6) * 3 * energy;
    const bodyR = Math.min(cssWidth, cssHeight) * 0.28;

    // 身体
    const bodyGradient = ctx.createLinearGradient(cx, cy - bodyR, cx, cy + bodyR * 1.6);
    bodyGradient.addColorStop(0, '#5fd3ff');
    bodyGradient.addColorStop(1, '#2b6fb8');
    ctx.fillStyle = bodyGradient;
    ctx.beginPath();
    ctx.ellipse(cx, cy + bodyR * 0.9, bodyR * 1.05, bodyR * 1.15, 0, 0, Math.PI * 2);
    ctx.fill();

    // 鱼鳍
    ctx.fillStyle = '#7fe0ff';
    for (const direction of [-1, 1] as const) {
      ctx.beginPath();
      ctx.moveTo(cx + direction * bodyR * 0.9, cy + bodyR * 0.7);
      ctx.quadraticCurveTo(
        cx + direction * bodyR * 1.7,
        cy + bodyR * (1.1 + Math.sin(frame * 3) * 0.06),
        cx + direction * bodyR * 0.8,
        cy + bodyR * 1.5,
      );
      ctx.closePath();
      ctx.fill();
    }

    // 眼睛
    ctx.fillStyle = '#08243a';
    for (const direction of [-1, 1] as const) {
      ctx.beginPath();
      ctx.ellipse(cx + direction * bodyR * 0.36, cy + bodyR * 0.55, bodyR * 0.11, bodyR * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const direction of [-1, 1] as const) {
      ctx.beginPath();
      ctx.arc(cx + direction * bodyR * 0.33, cy + bodyR * 0.51, bodyR * 0.035, 0, Math.PI * 2);
      ctx.fill();
    }

    // 嘴：由 mouthOpen 驱动，形成最小口型
    const mouthHeight = 4 + mouthOpen * bodyR * 0.28;
    ctx.fillStyle = '#0b3a5c';
    ctx.beginPath();
    ctx.ellipse(cx, cy + bodyR * 0.95, bodyR * 0.22, mouthHeight, 0, 0, Math.PI * 2);
    ctx.fill();

    rafId = requestAnimationFrame(draw);
  };

  return {
    setMouthOpen: (value) => {
      mouthOpen = Math.max(0, Math.min(1, value));
    },
    setEnergy: (value) => {
      energy = Math.max(0, Math.min(1, value));
    },
    start: () => {
      if (rafId !== null) return;
      lastTs = 0;
      rafId = requestAnimationFrame(draw);
    },
    stop: () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    },
  };
}
