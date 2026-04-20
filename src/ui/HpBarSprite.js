import * as THREE from 'three';

const CANVAS_W = 128;
const CANVAS_H = 18;

export function createHpBar({ width = 1.2, height = 0.16, yOffset = 2.0 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;

  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });

  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(width, height, 1);
  sprite.position.y = yOffset;
  sprite.visible = false;
  sprite.renderOrder = 999;

  draw(ctx, 1);

  return {
    sprite,
    setHp(current, max) {
      const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
      if (pct >= 0.999) {
        sprite.visible = false;
        return;
      }
      sprite.visible = true;
      draw(ctx, pct);
      tex.needsUpdate = true;
    },
    hide() {
      sprite.visible = false;
    },
  };
}

function draw(ctx, pct) {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // Background — warmer than pure black so the bar reads as UI at distance.
  ctx.fillStyle = 'rgba(18, 10, 14, 0.88)';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Fill — brighter palette for readability in the dark scene.
  const w = Math.max(0, CANVAS_W * pct);
  let color, highlight;
  if (pct > 0.55)      { color = '#ff3a3a'; highlight = '#ff7a5a'; }
  else if (pct > 0.25) { color = '#ff9a30'; highlight = '#ffc870'; }
  else                 { color = '#ffe85c'; highlight = '#fff2a0'; }

  ctx.fillStyle = color;
  ctx.fillRect(2, 2, Math.max(0, w - 4), CANVAS_H - 4);

  // Top-of-fill highlight row adds depth.
  ctx.fillStyle = highlight;
  ctx.globalAlpha = 0.65;
  ctx.fillRect(2, 2, Math.max(0, w - 4), 2);
  ctx.globalAlpha = 1;

  // Outer 1px stroke in the fill color helps it pop against bright scenes.
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.45;
  ctx.strokeRect(1.5, 1.5, CANVAS_W - 3, CANVAS_H - 3);
  ctx.globalAlpha = 1;

  // Border
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.95)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, CANVAS_W - 1, CANVAS_H - 1);
}
