import * as THREE from 'three';
import { createHpBar } from '../ui/HpBarSprite.js';
import { getRenderTime } from '../systems/NetClock.js';

export class RemoteGeneral {
  constructor(playerData) {
    this.id = playerData.id;
    this.name = playerData.name;
    this.connected = playerData.connected ?? true;

    this.position = new THREE.Vector3(playerData.pos.x, 0, playerData.pos.z);
    this._snaps = [];
    this._snapVx = 0;
    this._snapVz = 0;
    this._yaw = playerData.yaw ?? 0;

    this.mesh = this._build();
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this._yaw + Math.PI;

    this._hpBar = createHpBar({ width: 1.4, height: 0.16, yOffset: 2.95 });
    this.mesh.add(this._hpBar.sprite);
  }

  setHp(current, max) {
    this._hpBar.setHp(current, max);
  }

  _build() {
    const group = new THREE.Group();

    const color = this.connected ? 0xcc3333 : 0x555555;
    const emissive = this.connected ? 0x330000 : 0x000000;
    const mat = new THREE.MeshStandardMaterial({ color, emissive, roughness: 0.7 });

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.9, 4, 8), mat);
    body.position.y = 0.85;
    group.add(body);

    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), mat);
    skull.position.y = 1.6;
    group.add(skull);

    const eyeMat = new THREE.MeshBasicMaterial({ color: this.connected ? 0xff3030 : 0x552020 });
    const eyeGeom = new THREE.SphereGeometry(0.08, 8, 6);
    const eyeL = new THREE.Mesh(eyeGeom, eyeMat);
    const eyeR = new THREE.Mesh(eyeGeom, eyeMat);
    eyeL.position.set(-0.11, 1.63, 0.24);
    eyeR.position.set( 0.11, 1.63, 0.24);
    group.add(eyeL, eyeR);

    // Eye glow
    const glowMat = new THREE.MeshBasicMaterial({
      color: this.connected ? 0xff4040 : 0x553030,
      transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glowGeom = new THREE.SphereGeometry(0.17, 8, 6);
    const glowL = new THREE.Mesh(glowGeom, glowMat);
    const glowR = new THREE.Mesh(glowGeom, glowMat);
    glowL.position.set(-0.11, 1.63, 0.24);
    glowR.position.set( 0.11, 1.63, 0.24);
    group.add(glowL, glowR);

    // Floating name label
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = this.connected ? '#ff9988' : '#888888';
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 8;
    ctx.fillText(this.name, 128, 32);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const labelMat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false,
    });
    const label = new THREE.Sprite(labelMat);
    label.position.y = 2.6;
    label.scale.set(2.4, 0.6, 1);
    group.add(label);

    group.userData.bodyMaterial = mat;
    group.userData.eyeMaterial = eyeMat;
    group.userData.eyeGlowMaterial = glowMat;
    group.userData.labelCanvas = canvas;
    group.userData.labelCtx = ctx;
    group.userData.labelTexture = tex;

    return group;
  }

  setTarget(x, z, serverT, yaw) {
    const snaps = this._snaps;
    if (snaps.length > 0 && serverT <= snaps[snaps.length - 1].t) return;
    // Unwrap yaw relative to previous snap so interpolation takes the short arc
    // across the -PI/+PI seam.
    let storedYaw;
    if (typeof yaw === 'number') {
      if (snaps.length > 0) {
        const prev = snaps[snaps.length - 1].yaw;
        let d = yaw - prev;
        while (d >  Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        storedYaw = prev + d;
      } else {
        storedYaw = yaw;
      }
    } else {
      storedYaw = snaps.length > 0 ? snaps[snaps.length - 1].yaw : this._yaw;
    }
    snaps.push({ x, z, t: serverT, yaw: storedYaw });
    if (snaps.length > 3) snaps.shift();

    if (snaps.length >= 2) {
      const a = snaps[snaps.length - 2];
      const b = snaps[snaps.length - 1];
      const dt = (b.t - a.t) / 1000;
      if (dt > 0.001) {
        this._snapVx = (b.x - a.x) / dt;
        this._snapVz = (b.z - a.z) / dt;
      }
    }

    if (snaps.length === 1) {
      this.position.x = x;
      this.position.z = z;
      this._yaw = storedYaw;
    }
  }

  setConnected(connected) {
    if (this.connected === connected) return;
    this.connected = connected;
    const mat = this.mesh.userData.bodyMaterial;
    if (mat) {
      mat.color.setHex(connected ? 0xcc3333 : 0x555555);
      mat.emissive.setHex(connected ? 0x330000 : 0x000000);
    }
    const eye = this.mesh.userData.eyeMaterial;
    if (eye) eye.color.setHex(connected ? 0xff3030 : 0x552020);
    const glow = this.mesh.userData.eyeGlowMaterial;
    if (glow) glow.color.setHex(connected ? 0xff4040 : 0x553030);

    // Redraw label
    const ctx = this.mesh.userData.labelCtx;
    const canvas = this.mesh.userData.labelCanvas;
    const tex = this.mesh.userData.labelTexture;
    if (ctx && canvas && tex) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = connected ? '#ff9988' : '#888888';
      ctx.font = 'bold 26px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 8;
      ctx.fillText(this.name, 128, 32);
      tex.needsUpdate = true;
    }
  }

  update(dt) {
    if (this._snaps.length >= 2) {
      const renderT = getRenderTime();
      const snaps = this._snaps;
      let a = snaps[0];
      let b = snaps[1];
      for (let i = 1; i < snaps.length; i++) {
        if (snaps[i].t >= (renderT ?? Infinity)) break;
        a = snaps[i - 1];
        b = snaps[i];
      }
      const span = b.t - a.t;
      let k;
      if (renderT == null || span <= 0) k = 1;
      else k = (renderT - a.t) / span;

      if (k >= 0 && k <= 1) {
        this.position.x = a.x + (b.x - a.x) * k;
        this.position.z = a.z + (b.z - a.z) * k;
        this._yaw = a.yaw + (b.yaw - a.yaw) * k;
      } else if (k > 1) {
        const latest = snaps[snaps.length - 1];
        const overshoot = Math.min(0.15, ((renderT ?? latest.t) - latest.t) / 1000);
        this.position.x = latest.x + this._snapVx * overshoot;
        this.position.z = latest.z + this._snapVz * overshoot;
        this._yaw = latest.yaw;
      } else {
        this.position.x = a.x;
        this.position.z = a.z;
        this._yaw = a.yaw;
      }
    }
    this.mesh.position.set(this.position.x, 0, this.position.z);
    // Eyes sit at local +Z; a camera with yaw=0 looks toward -Z. Offset by PI
    // so the mesh faces the direction the remote player is looking.
    this.mesh.rotation.y = this._yaw + Math.PI;
  }
}
