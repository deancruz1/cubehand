// Areas players walk around (saved as outlines on the x z plane) and where the bot has been.

const MAX_POINTS = 4000;
const MAX_CORNERS = 40;

function lineDistance([px, pz], [ax, az], [bx, bz]) {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len === 0) return Math.hypot(px - ax, pz - az);
  return Math.abs(dx * (az - pz) - (ax - px) * dz) / len;
}

// Douglas-Peucker: drops points that sit close to the line between their neighbours.
function simplifyPath(points, tolerance) {
  if (points.length < 3) return points;
  let far = 0;
  let farDistance = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = lineDistance(points[i], points[0], points.at(-1));
    if (d > farDistance) {
      farDistance = d;
      far = i;
    }
  }
  if (farDistance <= tolerance) return [points[0], points.at(-1)];
  const left = simplifyPath(points.slice(0, far + 1), tolerance);
  const right = simplifyPath(points.slice(far), tolerance);
  return [...left.slice(0, -1), ...right];
}

// A closed loop is split at the point farthest from the start, so both halves are open paths.
export function simplifyOutline(points, tolerance = 1.5) {
  if (points.length < 4) return points;
  let far = 0;
  let farDistance = -1;
  points.forEach(([x, z], i) => {
    const d = Math.hypot(x - points[0][0], z - points[0][1]);
    if (d > farDistance) {
      farDistance = d;
      far = i;
    }
  });
  const a = simplifyPath(points.slice(0, far + 1), tolerance);
  const b = simplifyPath([...points.slice(far), points[0]], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

export function insideOutline(x, z, corners) {
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const [xi, zi] = corners[i];
    const [xj, zj] = corners[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function areaBounds(area) {
  const xs = area.corners.map((c) => c[0]);
  const zs = area.corners.map((c) => c[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  return {
    width: maxX - minX,
    depth: maxZ - minZ,
    center: { x: Math.floor((minX + maxX) / 2), y: area.minY, z: Math.floor((minZ + maxZ) / 2) }
  };
}

export function inArea(area, pos) {
  if (pos.y < area.minY - 10 || pos.y > area.maxY + 20) return false;
  return insideOutline(pos.x, pos.z, area.corners);
}

// An outline from the positions someone walked, or null when they didn't go around anything.
export function outlineFrom(points) {
  if (points.length < 8) return null;
  const flat = points.map((p) => [p.x, p.z]);
  let tolerance = 1;
  let corners = simplifyOutline(flat, tolerance);
  while (corners.length > MAX_CORNERS) {
    tolerance *= 1.5;
    corners = simplifyOutline(flat, tolerance);
  }
  corners = corners.map(([x, z]) => [Math.round(x), Math.round(z)]);
  const area = {
    corners,
    minY: Math.floor(Math.min(...points.map((p) => p.y))),
    maxY: Math.floor(Math.max(...points.map((p) => p.y)))
  };
  const { width, depth } = areaBounds(area);
  if (corners.length < 3 || width < 2 || depth < 2) return null;
  return area;
}

// The box between two corner blocks, both included.
export function boxArea(a, b) {
  const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x) + 1];
  const [z1, z2] = [Math.min(a.z, b.z), Math.max(a.z, b.z) + 1];
  return { corners: [[x1, z1], [x2, z1], [x2, z2], [x1, z2]], minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
}

// Samples where an entity walks, to turn into an outline later.
export class AreaRecorder {
  constructor() {
    this.active = null;
  }

  start(name, target, who) {
    this.stop();
    const points = [];
    const timer = setInterval(() => {
      const p = target()?.position;
      if (!p) return;
      const last = points.at(-1);
      if (last && Math.hypot(p.x - last.x, p.z - last.z) < 1) return;
      points.push({ x: p.x, y: p.y, z: p.z });
      if (points.length > MAX_POINTS) points.shift();
    }, 500);
    timer.unref?.();
    this.active = { name, who, points, timer };
  }

  stop() {
    const rec = this.active;
    if (rec) clearInterval(rec.timer);
    this.active = null;
    return rec;
  }

  status() {
    const rec = this.active;
    if (!rec) return null;
    return `Recording an area outline: ${rec.name ?? 'unnamed'}, tracking ${rec.who} (${rec.points.length} points so far). Save it with record_area when they're done.`;
  }
}

export function ago(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
}

// Places the bot stayed at or passed through, newest last.
export class TravelLog {
  constructor(max = 30) {
    this.max = max;
    this.points = [];
  }

  record(pos, now = Date.now()) {
    const p = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    const last = this.points.at(-1);
    if (last && Math.hypot(p.x - last.x, p.z - last.z) < 12 && Math.abs(p.y - last.y) < 6) {
      last.until = now;
      return;
    }
    this.points.push({ ...p, until: now });
    if (this.points.length > this.max) this.points.shift();
  }

  summary(now = Date.now(), count = 6) {
    const past = this.points.slice(0, -1).slice(-count).reverse();
    if (past.length === 0) return null;
    return `Where you've been lately (newest first): ${past.map((p) => `${p.x} ${p.y} ${p.z} (${ago(now - p.until)})`).join('; ')}`;
  }
}
