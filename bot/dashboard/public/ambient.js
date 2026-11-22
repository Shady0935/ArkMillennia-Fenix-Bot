(() => {
  'use strict';
  const canvas = document.getElementById('ambient-canvas');
  const toggle = document.getElementById('motion-toggle');
  const icon = document.getElementById('motion-icon');
  const label = document.getElementById('motion-label');
  const ctx = canvas?.getContext('2d', { alpha: true });
  if (!canvas || !toggle || !icon || !label || !ctx) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let paused = reducedMotion.matches;
  let visible = !document.hidden;
  let frame = 0;
  let lastFrame = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let elapsed = 0;
  let previousTime = 0;
  let seed = 0x5d3571;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const stars = Array.from({ length: 112 }, () => ({
    x: random(), y: random(), radius: .35 + random() * 1.05,
    phase: random() * Math.PI * 2, speed: .35 + random() * 1.3,
    depth: .2 + random() * .8, gold: random() > .72,
  }));
  const streaks = Array.from({ length: 8 }, () => ({
    x: random(), y: random() * .86, phase: random(), speed: .012 + random() * .022,
    length: 26 + random() * 62, alpha: .12 + random() * .2, gold: random() > .48,
  }));

  function resize() {
    const bounds = canvas.parentElement.getBoundingClientRect();
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (paused) paint(elapsed);
  }

  function paint(time) {
    ctx.clearRect(0, 0, width, height);
    for (const star of stars) {
      const twinkle = .18 + .48 * (.5 + .5 * Math.sin(time * star.speed + star.phase));
      const x = (star.x * width + Math.sin(time * .05 + star.phase) * star.depth * 5 + width) % width;
      const y = (star.y * height + Math.cos(time * .04 + star.phase) * star.depth * 3 + height) % height;
      ctx.beginPath();
      ctx.fillStyle = star.gold ? `rgba(255,216,151,${twinkle})` : `rgba(189,214,228,${twinkle * .78})`;
      ctx.arc(x, y, star.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const streak of streaks) {
      const progress = (streak.phase + time * streak.speed) % 1;
      const x = ((streak.x + progress * .5) % 1) * width;
      const y = (streak.y + Math.sin(progress * Math.PI * 2 + streak.phase) * .035) * height;
      const gradient = ctx.createLinearGradient(x - streak.length, y + streak.length * .27, x, y);
      const color = streak.gold ? '255,207,130' : '104,181,158';
      gradient.addColorStop(0, `rgba(${color},0)`);
      gradient.addColorStop(1, `rgba(${color},${streak.alpha})`);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x - streak.length, y + streak.length * .27);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  }

  function tick(timestamp) {
    frame = 0;
    if (paused || !visible) return;
    if (timestamp - lastFrame >= 1000 / 30) {
      if (previousTime) elapsed += Math.min((timestamp - previousTime) / 1000, .08);
      previousTime = timestamp;
      lastFrame = timestamp;
      paint(elapsed);
    }
    frame = requestAnimationFrame(tick);
  }

  function start() {
    if (!paused && visible && !frame) {
      previousTime = 0;
      frame = requestAnimationFrame(tick);
    }
  }
  function updateControl() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', paused ? 'M8 5v14l11-7z' : 'M6 5h4v14H6zm8 0h4v14h-4z');
    svg.append(path);
    icon.replaceChildren(svg);
    label.textContent = paused ? 'Reanudar animación' : 'Pausar animación';
    toggle.setAttribute('aria-label', paused ? 'Reanudar animación del fondo' : 'Pausar animación del fondo');
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.title = label.textContent;
  }
  function setPaused(value) {
    paused = value;
    if (paused && frame) { cancelAnimationFrame(frame); frame = 0; }
    updateControl();
    if (!paused) start(); else paint(elapsed);
  }

  toggle.addEventListener('click', () => setPaused(!paused));
  document.addEventListener('visibilitychange', () => {
    visible = !document.hidden;
    if (!visible && frame) { cancelAnimationFrame(frame); frame = 0; }
    else start();
  });
  reducedMotion.addEventListener('change', event => setPaused(event.matches));
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(canvas.parentElement);
  else window.addEventListener('resize', resize);
  resize();
  updateControl();
  paint(0);
  start();
})();
