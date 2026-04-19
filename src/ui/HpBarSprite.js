import * as THREE from 'three';

const CANVAS_W = 64;
const CANVAS_H = 8;

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

  // Background
  ctx.fillStyle = 'rgba(15, 5, 8, 0.85)';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Fill
  const w = Math.max(0, CANVAS_W * pct);
  let color;
  if (pct > 0.55)      color = '#e83030';
  else if (pct > 0.25) color = '#e88830';
  else                 color = '#ffe040';
  ctx.fillStyle = color;
  ctx.fillRect(1, 1, Math.max(0, w - 2), CANVAS_H - 2);

  // Border
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.95)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, CANVAS_W - 1, CANVAS_H - 1);
}
